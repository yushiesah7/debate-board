// @ts-check
/**
 * server.mjs — REST + SSE の結線（SPEC.md §8）。engine.mjs / state.mjs / adapters/* /
 * public/index.html を1つの http.Server にまとめる。
 *
 * `createServer({config, adapters, stateDir})` は **listen していない** node:http.Server を返す。
 * 呼び出し側が `.listen(...)` する設計にしてあるのは、テストが ephemeral port
 * （`listen(0)`）でバインドできるようにするため。直接実行（`node src/server.mjs`）時のみ
 * このモール自身が config.port で `.listen()` する（下部の direct-run ブロック）。
 *
 * サーバ内部状態（currentBoard / awaitingHuman / SSEクライアント集合 / participants）は
 * createServer() 呼び出しごとにクロージャで新規に持つ。グローバル変数を使わないので、
 * 複数サーバ（並列テスト等）が状態を共有することはない。
 *
 * 同時に走る議論は1つ（SPEC §9）。/api/start 実行中の再startは409。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from './config.mjs';
import { createDebate, saveBoard, applyCardOps, loadTranscript, appendTranscript, normalizeRules } from './state.mjs';
import { buildInterjectPrompt, composeRulesFor, boardSummary, TURN_SCHEMA } from './prompt.mjs';
import { runDebate } from './engine.mjs';
import { resolveAdapter } from './adapters/index.mjs';
import { makeHuman, HUMAN_TIMEOUT_MS } from './adapters/human.mjs';
import { discoverAdapterOptions, staticOptionsResponse } from './options.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_INDEX = path.join(__dirname, '..', 'public', 'index.html');
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const DEFAULT_RULES_PATH = path.join(__dirname, '..', 'PARTICIPANT_RULES.md');

/** /api/start の追加ルール（rules）の最大文字数。超過は400。 */
const MAX_EXTRA_RULES_CHARS = 4000;

/** POST /api/session-rules の common / byId 各エントリの最大文字数。超過は400。 */
const MAX_SESSION_RULES_CHARS = 4000;

/** POSTボディの上限（暴走・DoS対策のガード。ローカル専用アプリなので大きめでよい）。 */
const MAX_BODY_BYTES = 1024 * 1024;

/** POST /api/participant で model/effort/pcAccess を変更できるアダプタ種別（CLI系のみ）。 */
const CLI_ADAPTER_NAMES = ['claude', 'codex', 'grok'];

/** GET /api/options の発見結果メモリキャッシュのTTL。 */
const OPTIONS_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * デフォルトルールファイル（rulesPath=PARTICIPANT_RULES.md）を読む。
 * ファイルが無ければ ""。startのたびに呼ぶ（＝編集が次の議論から反映される）。
 * ファイル読込はサーバ/CLI側の責務（engine/stateはfsを読まない）。
 * @param {string} rulesPath
 * @returns {string}
 */
export function readDefaultRules(rulesPath) {
  try {
    return fs.readFileSync(rulesPath, 'utf8').trim();
  } catch {
    return '';
  }
}

/** POST /api/interject の依頼テキストの最大文字数。超過は400。 */
const MAX_INTERJECT_CHARS = 4000;

/**
 * 議論のrules/notesをJSONファイルとして書き出す（自動エクスポート本体。server/CLI共用）。
 * ファイル名: `<YYYYMMDD-HHmmss>_<お題スラッグ最大20字>-rules.json` / 同prefix `-notes.json`
 * （GUIの手動エクスポートと同形式）。ディレクトリは無ければ再帰作成。
 * 書き込み失敗はthrowする（呼び出し側でcatchしてconsole.errorのみ＝議論は壊さない）。
 * @param {string} dirPath - 書き出し先ディレクトリ（絶対パス推奨）
 * @param {object} board
 * @returns {string[]} 書き出したファイル名（2件）
 */
export function exportDebateArtifacts(dirPath, board) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug =
    String(board?.meta?.topic ?? '')
      .replace(/[\\/:*?"<>|\s]+/g, '-') // Windowsで不正なファイル名文字と空白を除去
      .replace(/^-+|-+$/g, '')
      .slice(0, 20) || 'debate';
  const prefix = `${stamp}_${slug}`;

  const rules = normalizeRules(board?.meta?.rules);
  const rulesJson = {
    type: 'debate-board-rules',
    version: 1,
    common: rules.common,
    participants: { ...rules.byId },
  };
  const notesJson = {
    type: 'debate-board-notes',
    version: 1,
    notes: board?.notes ?? {},
    summary: board?.summary ?? null,
    cards: (board?.cards ?? []).map((c) => ({ lane: c.lane, title: c.title, body: c.body })),
  };

  fs.mkdirSync(dirPath, { recursive: true });
  const files = [`${prefix}-rules.json`, `${prefix}-notes.json`];
  fs.writeFileSync(path.join(dirPath, files[0]), JSON.stringify(rulesJson, null, 2), 'utf8');
  fs.writeFileSync(path.join(dirPath, files[1]), JSON.stringify(notesJson, null, 2), 'utf8');
  return files;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * リクエストボディを読み取りJSONとしてパースする。
 * 空ボディは `{}` として扱う。不正JSON・非オブジェクト・サイズ超過は reject する。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      chunks.push(chunk);
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        reject(new Error('request body too large'));
      }
    });
    req.on('error', (err) => reject(err));
    req.on('end', () => {
      if (tooBig) return;
      // Buffer.concat後に一括デコード: chunkごとの暗黙toString()だと、マルチバイト
      // UTF-8文字がチャンク境界で分断された場合に置換文字(U+FFFD)へ化けるため
      const data = Buffer.concat(chunks).toString('utf8');
      if (data.trim() === '') {
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new Error('request body must be a JSON object'));
        return;
      }
      resolve(parsed);
    });
  });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {object} body
 */
function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {string} message
 */
function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

/**
 * @param {object} args
 * @param {import('./config.mjs').Config} args.config
 * @param {Object<string, {speak: (ctx: object) => Promise<object>}>} [args.adapters] - テスト用: participantId -> フェイクアダプタ。指定されたidだけ上書きし、それ以外は通常解決する
 * @param {string} [args.stateDir] - state ルートディレクトリ（既定 "state"）
 * @param {string} [args.configPath] - POST /api/participant の永続化先（既定はリポルートの config.json）
 * @param {string} [args.rulesPath] - 参加AIの基本ルールファイル（既定はリポルートの PARTICIPANT_RULES.md。start時に毎回読む）
 * @param {(args: object) => Promise<{adapters: object}>} [args.discoverOptions] - テスト用: GET /api/options の発見関数の差し替え（既定は options.mjs の実装）
 * @returns {import('node:http').Server}
 */
export function createServer({
  config,
  adapters: injectedAdapters,
  stateDir = 'state',
  configPath = DEFAULT_CONFIG_PATH,
  rulesPath = DEFAULT_RULES_PATH,
  discoverOptions = discoverAdapterOptions,
} = {}) {
  if (!config) throw new Error('createServer requires a config');

  /** @type {object|null} 進行中（または直近に完了した）議論のboard */
  let currentBoard = null;
  /** @type {{participantId:string}|null} */
  let awaitingHuman = null;
  /** @type {{participantId:string, resolve:(v:any)=>void, timer:NodeJS.Timeout}|null} */
  let pendingHuman = null;
  /** 議論開始前のトグル状態を持つ、configのローカル可変コピー（開始後はboard.participantsが正） */
  let participants = config.participants.map((p) => ({ ...p }));
  /** @type {Set<import('node:http').ServerResponse>} */
  const sseClients = new Set();
  /** @type {{data: object, fetchedAt: number}|null} GET /api/options の発見結果キャッシュ（TTL 10分） */
  let optionsCache = null;
  /** @type {Promise<object>|null} 収集中の重複実行を防ぐインフライトPromise */
  let optionsInflight = null;
  /**
   * その場のルールの開始前ステージング（git外・メモリのみ）。
   * /api/start 時に defaultSnapshot（ファイル読込）と合成されて board.meta.rules になる。
   * 実行中の編集はステージングではなく board.meta.rules を直接mutateする。
   * @type {{common: string, byId: Object<string, string>}}
   */
  const sessionRules = { common: '', byId: {} };
  /**
   * 現在speak実行中の参加者（GUIの「考え中」インジケータ用）。
   * turn-startで設定、turn完了・endedで解除。シンセシス中は phase:'synthesis'（round:null）。
   * @type {null | {participantId: string, round: number|null, phase: 'turn'|'synthesis', since: string}}
   */
  let speaking = null;

  /**
   * 自動エクスポート先（config.autoExportDir。相対パスはリポルート基準に解決）。
   * テスト等でconfigオブジェクトに autoExportDir が無い場合は自動エクスポート無効
   * （loadConfig経由の実運用では常に既定 "exports" が入る）。
   * @type {string|null}
   */
  const autoExportPath =
    typeof config.autoExportDir === 'string' && config.autoExportDir.trim() !== ''
      ? path.isAbsolute(config.autoExportDir)
        ? config.autoExportDir
        : path.join(__dirname, '..', config.autoExportDir)
      : null;

  /** @param {{type:string, [k:string]:any}} event */
  function broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        // クライアントが既に切断済み。'close'ハンドラがSetから除去する
      }
    }
  }

  /** @param {{text:string}|{skip:true}|null} outcome */
  function resolvePendingHuman(outcome) {
    if (!pendingHuman) return;
    clearTimeout(pendingHuman.timer);
    const { resolve } = pendingHuman;
    pendingHuman = null;
    awaitingHuman = null;
    resolve(outcome);
  }

  /** @type {import('./adapters/human.mjs').HumanBridge} */
  const humanBridge = {
    wait(participantId, timeoutMs) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolvePendingHuman({ skip: true }), timeoutMs);
        timer.unref?.();
        pendingHuman = { participantId, resolve, timer };
        awaitingHuman = { participantId };
        broadcast({ type: 'await-human', participantId });
      });
    },
  };

  function isPaused() {
    return !!currentBoard && currentBoard.meta.status === 'paused';
  }

  /**
   * 一時停止ゲート付きアダプタでラップする。実装は「次のspeak呼び出し前に
   * pausedが解除されるまで待機する」（進行中のspeak自体は中断しない）。
   * @param {{speak: (ctx: object) => Promise<object>}} inner
   */
  function withPauseGate(inner) {
    return {
      async speak(ctx) {
        while (isPaused()) {
          await sleep(300);
        }
        return inner.speak(ctx);
      },
    };
  }

  /** speaking-progress SSEのスロットル間隔（洪水防止。断片は間隔内でまとめて1通にする） */
  const PROGRESS_THROTTLE_MS = 100;

  /**
   * ctx.onProgress を注入するラッパー。アダプタが流すテキスト断片を
   * 100ms毎にまとめて `{"type":"speaking-progress","participantId","text"}` として
   * SSEブロードキャストする（/api/stateには載せない揮発表示。リロードで消えてよい）。
   * @param {{speak: (ctx: object) => Promise<object>}} inner
   * @param {string} participantId
   */
  function withProgress(inner, participantId) {
    return {
      async speak(ctx) {
        let buf = '';
        /** @type {NodeJS.Timeout|null} */
        let timer = null;
        const flush = () => {
          timer = null;
          if (buf === '') return;
          const text = buf;
          buf = '';
          broadcast({ type: 'speaking-progress', participantId, text });
        };
        const onProgress = (text) => {
          if (typeof text !== 'string' || text === '') return;
          buf += text;
          if (!timer) {
            timer = setTimeout(flush, PROGRESS_THROTTLE_MS);
            timer.unref?.();
          }
        };
        try {
          return await inner.speak({ ...ctx, onProgress });
        } finally {
          if (timer) clearTimeout(timer);
          flush(); // 最後の断片を取りこぼさない
        }
      },
    };
  }

  /** @param {object} participant */
  function buildAdapterFor(participant) {
    if (injectedAdapters && injectedAdapters[participant.id]) {
      return withPauseGate(withProgress(injectedAdapters[participant.id], participant.id));
    }
    if (participant.adapter === 'human') {
      return withPauseGate(makeHuman(humanBridge)); // humanは進捗なし（入力バーが出る）
    }
    return withPauseGate(withProgress({ speak: resolveAdapter(participant.adapter) }, participant.id));
  }

  function currentParticipantsView() {
    const list = currentBoard ? currentBoard.participants : participants;
    return list.map((p) => ({
      id: p.id,
      name: p.name,
      adapter: p.adapter,
      enabled: p.enabled,
      // model/effort/pcAccess: 参加者設定UI（POST /api/participant）向けの追加フィールド。
      // 既存クライアントは未知フィールドを無視するだけなので後方互換（SPEC §8 追記対応）。
      model: p.model ?? null,
      effort: p.effort ?? null,
      pcAccess: p.pcAccess ?? null,
    }));
  }

  /** engineのメモリ履歴の代わりに transcript.jsonl（毎ターン同期保存済み）から読み直す */
  function currentTranscriptView() {
    if (!currentBoard) return [];
    const { entries } = loadTranscript(stateDir, currentBoard.meta.id);
    return entries.map((e) => {
      const speaker = currentBoard.participants.find((p) => p.id === e.participantId);
      return {
        round: e.round,
        speaker: speaker ? speaker.name : e.participantId,
        text: typeof e.utterance === 'string' ? e.utterance : '',
        ts: e.timestamp ?? null,
        // 割り込み依頼（interject）のバッジ表示用（通常発言では undefined）
        ...(e.interject ? { interject: e.interject, targetId: e.targetId ?? null } : {}),
      };
    });
  }

  /** 議論が「実行中」（rules編集がboardへ直接効く状態）かどうか */
  function isDebateActive() {
    return !!currentBoard && currentBoard.meta.status !== 'ended';
  }

  /**
   * GUI契約用の現在の実効rulesビュー `{default, common, byId}`。
   * - 実行中: board.meta.rules（defaultSnapshot→defaultに改名して返す）
   * - idle/終了後: ステージング＋rulesPathの現在の中身
   */
  function currentRulesView() {
    if (isDebateActive()) {
      const r = normalizeRules(currentBoard.meta.rules);
      return { default: r.defaultSnapshot, common: r.common, byId: { ...r.byId } };
    }
    return {
      default: readDefaultRules(rulesPath),
      common: sessionRules.common,
      byId: { ...sessionRules.byId },
    };
  }

  /** SPEC §8 の GET /api/state 応答形を組み立てる */
  function buildStateResponse() {
    if (!currentBoard) {
      return {
        board: {
          meta: {
            topic: '',
            round: 0,
            maxRounds: config.maxRounds,
            status: 'idle',
            endedBy: null,
            rules: currentRulesView(),
          },
          cards: [],
          notes: {},
          summary: null,
        },
        participants: currentParticipantsView(),
        awaitingHuman,
        speaking,
        transcript: [],
      };
    }
    return {
      board: {
        meta: {
          topic: currentBoard.meta.topic,
          round: currentBoard.meta.round,
          maxRounds: currentBoard.meta.maxRounds,
          status: currentBoard.meta.status,
          endedBy: currentBoard.meta.endedBy ?? null,
          rules: currentRulesView(),
        },
        cards: currentBoard.cards,
        notes: currentBoard.notes,
        summary: currentBoard.summary,
      },
      participants: currentParticipantsView(),
      awaitingHuman,
      speaking,
      transcript: currentTranscriptView(),
    };
  }

  function findHumanId() {
    const list = currentBoard ? currentBoard.participants : participants;
    const human = list.find((p) => p.adapter === 'human');
    return human ? human.id : 'you';
  }

  /** @param {{type:string, [k:string]:any}} event */
  function onEngineEvent(event) {
    if (event.type === 'turn-start') {
      speaking = {
        participantId: event.participantId,
        round: event.round,
        phase: 'turn',
        since: new Date().toISOString(),
      };
      broadcast({ type: 'turn-start', participantId: event.participantId, round: event.round });
      return;
    }
    if (event.type === 'synthesis-start') {
      speaking = {
        participantId: event.participantId,
        round: null,
        phase: 'synthesis',
        since: new Date().toISOString(),
      };
      broadcast({ type: 'synthesis-start', participantId: event.participantId });
      return;
    }
    if (event.type === 'turn') {
      speaking = null; // 発言完了（実発言はupdate経由の/api/state再取得で反映される）
      broadcast({ type: 'update' });
      return;
    }
    if (event.type === 'ended') {
      speaking = null; // シンセシス完了含む
      // 議論終了時の自動エクスポート（失敗しても議論は壊さない: console.errorのみ）
      if (autoExportPath && currentBoard) {
        try {
          const files = exportDebateArtifacts(autoExportPath, currentBoard);
          broadcast({ type: 'auto-export', files });
        } catch (err) {
          console.error('auto-export failed:', err?.message ?? err);
        }
      }
      // 'update'も併せて流す: GUI側の既存ハンドラ（update時に/api/state再取得）だけでも
      // summaryが反映されるようにするための保険（'ended'固有ハンドラが無くても壊れない）
      broadcast({ type: 'update' });
      broadcast({ type: 'ended' });
      return;
    }
    // 'warning' 等も「boardが変わったので再取得してね」の合図
    broadcast({ type: 'update' });
  }

  /** currentBoard（あれば）向けにアダプタ群を組み立て、runDebateをバックグラウンド起動する */
  function launchDebate(board) {
    const adaptersMap = {};
    for (const p of board.participants) {
      adaptersMap[p.id] = buildAdapterFor(p);
    }
    // バックグラウンド起動（awaitしない）。runDebateはエンジン仕様上reject
    // しない設計だが、万一の例外でプロセスが落ちないよう防御的にcatchする。
    runDebate({
      stateDir,
      board,
      adapters: adaptersMap,
      onEvent: onEngineEvent,
      humanTimeoutMs: HUMAN_TIMEOUT_MS,
    }).catch(() => {});
  }

  /**
   * @param {string} topic
   * @param {number} maxRounds
   * @param {string} [extraRules] - 開始モーダルの追加ルール（commonへ追記結合される）
   * @param {{cards?:boolean, notes?:boolean, rules?:boolean, summaryCard?:boolean}|null} [inherit]
   *   - 前回の議論（ended状態のcurrentBoard）からの引き継ぎ指定。前回boardが無ければ無視
   */
  function startDebate(topic, maxRounds, extraRules, inherit) {
    // 引き継ぎ元: endedなboardがあるときだけ有効
    const prev = currentBoard && currentBoard.meta.status === 'ended' ? currentBoard : null;
    const inheritOpts = prev && inherit && typeof inherit === 'object' ? inherit : null;

    // ルール3層を構成: defaultSnapshotはstart時に毎回ファイルから読んで固定保存。
    // 通常はステージング（sessionRules）、inherit.rules指定時は前回boardのcommon/byIdを優先採用
    const baseRules =
      inheritOpts?.rules && prev ? normalizeRules(prev.meta.rules) : sessionRules;
    const extra = typeof extraRules === 'string' ? extraRules.trim() : '';
    const common = baseRules.common && extra
      ? `${baseRules.common}\n${extra}`
      : baseRules.common || extra;
    const rules = {
      defaultSnapshot: readDefaultRules(rulesPath),
      common,
      byId: { ...baseRules.byId },
    };
    speaking = null; // 前の議論の残留インジケータをクリア
    const board = createDebate(stateDir, topic, { maxRounds, rules, participants });

    // ---- 前回の議論からのseed（cards / notes / summaryCard） ----
    if (inheritOpts) {
      const now = new Date().toISOString();
      if (inheritOpts.cards && Array.isArray(prev.cards)) {
        for (const c of prev.cards) {
          if (!c || typeof c !== 'object') continue;
          board.cards.push({
            id: `c${board.meta.cardSeq++}`, // 新ID採番（cardSeq整合）
            lane: c.lane,
            title: c.title,
            body: c.body,
            createdBy: c.createdBy, // 維持
            updatedBy: c.updatedBy ?? c.createdBy,
            updatedAt: now,
          });
        }
      }
      if (inheritOpts.notes && prev.notes && typeof prev.notes === 'object') {
        for (const [pid, text] of Object.entries(prev.notes)) {
          if (typeof text === 'string' && pid in board.notes) {
            board.notes[pid] = text;
          }
        }
      }
      if (inheritOpts.summaryCard && typeof prev.summary === 'string' && prev.summary.trim() !== '') {
        board.cards.push({
          id: `c${board.meta.cardSeq++}`,
          lane: 'decided',
          title: `📋 前回の結論（${prev.meta.topic}）`,
          body: prev.summary,
          createdBy: 'inherit',
          updatedBy: 'inherit',
          updatedAt: now,
        });
      }
      saveBoard(stateDir, board); // seed分を確定保存してからエンジン起動
    }

    currentBoard = board;
    launchDebate(board);
    return board;
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      try {
        sendError(res, 500, err?.message ?? String(err));
      } catch {
        // レスポンスが既に書き込み途中の可能性。これ以上は何もできない
      }
    });
  });

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname === '/') {
      if (req.method !== 'GET') return sendError(res, 405, 'method not allowed');
      return serveIndex(res);
    }

    if (pathname === '/api/state') {
      if (req.method !== 'GET') return sendError(res, 405, 'method not allowed');
      return sendJson(res, 200, buildStateResponse());
    }

    if (pathname === '/api/events') {
      if (req.method !== 'GET') return sendError(res, 405, 'method not allowed');
      return serveEvents(req, res);
    }

    if (pathname === '/api/options') {
      if (req.method !== 'GET') return sendError(res, 405, 'method not allowed');
      return serveOptions(res);
    }

    if (pathname === '/api/rules') {
      if (req.method !== 'GET') return sendError(res, 405, 'method not allowed');
      return serveRules(res);
    }

    const postRoutes = {
      '/api/start': handleStart,
      '/api/pause': handlePause,
      '/api/end': handleEnd,
      '/api/extend': handleExtend,
      '/api/toggle': handleToggle,
      '/api/participant': handleParticipant,
      '/api/session-rules': handleSessionRules,
      '/api/import-notes': handleImportNotes,
      '/api/interject': handleInterject,
      '/api/card': handleCard,
      '/api/say': handleSay,
      '/api/skip': handleSkip,
      '/api/note': handleNote,
    };

    if (Object.prototype.hasOwnProperty.call(postRoutes, pathname)) {
      if (req.method !== 'POST') return sendError(res, 405, 'method not allowed');
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendError(res, 400, err.message);
      }
      return postRoutes[pathname](body, res);
    }

    return sendError(res, 404, 'not found');
  }

  /**
   * GET /api/rules — デフォルトルールファイル（rulesPath=PARTICIPANT_RULES.md）の
   * 現在の中身を閲覧用に返す。毎回ファイルから読む（キャッシュしない）。無ければ ""。
   * デフォルトルールはリポ文書なのでGUIからは編集不可（閲覧のみ）。
   * @param {import('node:http').ServerResponse} res
   */
  function serveRules(res) {
    let text = '';
    try {
      text = fs.readFileSync(rulesPath, 'utf8');
    } catch {
      text = '';
    }
    return sendJson(res, 200, { default: text });
  }

  /**
   * GET /api/options — 参加者設定UI向けのmodel/effort候補。
   * 初回呼び出し時に実環境から収集し、10分間メモリキャッシュする。
   * 発見関数がどう失敗しても静的フォールバックを返し、**常に200**。
   * @param {import('node:http').ServerResponse} res
   */
  async function serveOptions(res) {
    const now = Date.now();
    if (optionsCache && now - optionsCache.fetchedAt <= OPTIONS_CACHE_TTL_MS) {
      return sendJson(res, 200, optionsCache.data);
    }
    if (!optionsInflight) {
      optionsInflight = Promise.resolve()
        .then(() => discoverOptions({ config }))
        .then((data) => {
          if (!data || typeof data !== 'object' || !data.adapters) {
            return staticOptionsResponse();
          }
          return data;
        })
        .catch(() => staticOptionsResponse())
        .then((data) => {
          optionsCache = { data, fetchedAt: Date.now() };
          optionsInflight = null;
          return data;
        });
    }
    const data = await optionsInflight;
    return sendJson(res, 200, data);
  }

  /** @param {import('node:http').ServerResponse} res */
  function serveIndex(res) {
    fs.readFile(PUBLIC_INDEX, (err, data) => {
      if (err) {
        sendError(res, 500, 'failed to read public/index.html');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function serveEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    // プロキシ等でのアイドルタイムアウト対策のハートビート（コメント行はSSEクライアントに無視される）
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // ignore; 'close'で後始末する
      }
    }, 15000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  }

  function handleStart(body, res) {
    if (currentBoard && currentBoard.meta.status !== 'ended') {
      return sendError(res, 409, 'a debate is already in progress');
    }
    if (typeof body.topic !== 'string' || body.topic.trim() === '') {
      return sendError(res, 400, 'topic (non-empty string) is required');
    }
    const maxRounds =
      Number.isInteger(body.maxRounds) && body.maxRounds > 0 ? body.maxRounds : config.maxRounds;
    if (body.rules !== undefined && body.rules !== null && typeof body.rules !== 'string') {
      return sendError(res, 400, 'rules must be a string when specified');
    }
    const extraRules = typeof body.rules === 'string' ? body.rules : '';
    if (extraRules.length > MAX_EXTRA_RULES_CHARS) {
      return sendError(res, 400, `rules must be at most ${MAX_EXTRA_RULES_CHARS} characters`);
    }
    const enabledCount = participants.filter((p) => p.enabled).length;
    if (enabledCount < 2) {
      return sendError(res, 400, 'at least 2 enabled participants are required to start');
    }
    let inherit = null;
    if (body.inherit !== undefined && body.inherit !== null) {
      if (typeof body.inherit !== 'object' || Array.isArray(body.inherit)) {
        return sendError(res, 400, 'inherit must be an object when specified');
      }
      inherit = {
        cards: !!body.inherit.cards,
        notes: !!body.inherit.notes,
        rules: !!body.inherit.rules,
        summaryCard: !!body.inherit.summaryCard,
      };
    }
    startDebate(body.topic, maxRounds, extraRules, inherit);
    return sendJson(res, 200, buildStateResponse());
  }

  /**
   * POST /api/extend — ラウンド延長（＋終了後の再開）。
   * - 実行中/一時停止中: maxRounds += rounds（エンジンは毎周 board.meta.maxRounds を
   *   生値で評価するのでそのまま効く）
   * - 終了後: maxRounds加算→status="running"へ戻しendedBy=nullにしてから runDebate を
   *   再起動（既存の再開セマンティクス: transcriptから履歴復元・meta.round+1から続き。
   *   engineのended即no-opガードに掛からないようstatusを戻してから呼ぶ）。
   *   summaryは再終了時のシンセシスで上書きされる
   * - 議論なし（idle）: 400／rounds不正（整数1〜20以外）: 400
   */
  function handleExtend(body, res) {
    if (!currentBoard) return sendError(res, 400, 'no debate to extend');
    const rounds = body.rounds;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) {
      return sendError(res, 400, 'rounds must be an integer in 1..20');
    }
    currentBoard.meta.maxRounds += rounds;
    if (currentBoard.meta.status === 'ended') {
      // 終了後の再開: 進行状態へ戻してエンジンを再起動する
      currentBoard.meta.status = 'running';
      currentBoard.meta.endedBy = null;
      saveBoard(stateDir, currentBoard);
      launchDebate(currentBoard);
    } else {
      saveBoard(stateDir, currentBoard);
    }
    broadcast({ type: 'update' });
    return sendJson(res, 200, buildStateResponse());
  }

  function handlePause(_body, res) {
    if (!currentBoard || currentBoard.meta.status === 'ended') {
      return sendError(res, 400, 'no debate to pause/resume');
    }
    if (currentBoard.meta.status === 'running') {
      currentBoard.meta.status = 'paused';
    } else if (currentBoard.meta.status === 'paused') {
      currentBoard.meta.status = 'running';
    } else {
      return sendError(res, 400, `cannot toggle pause while status is "${currentBoard.meta.status}"`);
    }
    saveBoard(stateDir, currentBoard);
    broadcast({ type: 'update' });
    return sendJson(res, 200, buildStateResponse());
  }

  function handleEnd(_body, res) {
    if (!currentBoard || currentBoard.meta.status === 'ended') {
      return sendError(res, 400, 'no debate to end');
    }
    // pause中でも終了できるようstatusを直接'ending'へ（withPauseGateはpaused以外で解除される）
    currentBoard.meta.status = 'ending';
    saveBoard(stateDir, currentBoard);
    // humanターン待機中なら保留Promiseをskip相当で即解決する。
    // これをしないとエンジンがhumanタイムアウト（最大5分）までブロックし続ける
    resolvePendingHuman({ skip: true });
    broadcast({ type: 'update' });
    return sendJson(res, 200, buildStateResponse());
  }

  function handleToggle(body, res) {
    if (typeof body.id !== 'string' || typeof body.enabled !== 'boolean') {
      return sendError(res, 400, 'id (string) and enabled (boolean) are required');
    }
    const p = participants.find((x) => x.id === body.id);
    if (!p) return sendError(res, 404, `unknown participant id "${body.id}"`);
    p.enabled = body.enabled;
    if (currentBoard) {
      const bp = currentBoard.participants.find((x) => x.id === body.id);
      if (bp) {
        bp.enabled = body.enabled;
        saveBoard(stateDir, currentBoard);
      }
    }
    broadcast({ type: 'update' });
    return sendJson(res, 200, buildStateResponse());
  }

  /**
   * body.value を「フィールド更新」の指示に正規化する。
   * - 非空文字列 → そのフィールドを設定
   * - null または "" → そのフィールドを削除（CLI既定への復帰）
   * - それ以外の型 → 不正
   * @param {unknown} value
   * @returns {{action:'set', value:string}|{action:'delete'}|{action:'invalid'}}
   */
  function normalizeFieldUpdate(value) {
    if (value === null || value === '') return { action: 'delete' };
    if (typeof value === 'string') return { action: 'set', value };
    return { action: 'invalid' };
  }

  /**
   * patch（{model?, effort?, pcAccess?}; 値が undefined のキーは「削除」を意味する）を
   * 参加者オブジェクトへ破壊的に適用する。
   * @param {object} target
   * @param {Record<string, string|undefined>} patch
   */
  function applyParticipantPatch(target, patch) {
    for (const key of ['model', 'effort', 'pcAccess']) {
      if (!(key in patch)) continue;
      if (patch[key] === undefined) {
        delete target[key];
      } else {
        target[key] = patch[key];
      }
    }
  }

  /**
   * configPath へ「読み→該当参加者だけpatch→書き戻し」する。saveBoard同様、
   * tmpファイル→renameSync で原子的に書き込む。
   * ファイルが存在しない・壊れている場合は起動時に読み込んだ config 全体から新規作成する。
   * @param {string} id
   * @param {Record<string, string|undefined>} patch
   */
  function persistParticipantConfig(id, patch) {
    /** @type {any} */
    let fileConfig;
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      fileConfig = null;
    }
    if (!fileConfig || typeof fileConfig !== 'object' || !Array.isArray(fileConfig.participants)) {
      fileConfig = {
        port: config.port,
        maxRounds: config.maxRounds,
        participants: config.participants.map((p) => ({ ...p })),
      };
    }
    const idx = fileConfig.participants.findIndex((p) => p && p.id === id);
    if (idx === -1) return; // configPathにその参加者がいない（想定外だが例外にはしない）
    const target = { ...fileConfig.participants[idx] };
    applyParticipantPatch(target, patch);
    fileConfig.participants[idx] = target;

    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(fileConfig, null, 2), 'utf8');
    fs.renameSync(tmp, configPath);
  }

  function handleParticipant(body, res) {
    if (typeof body.id !== 'string' || body.id === '') {
      return sendError(res, 400, 'id (string) is required');
    }
    const p = participants.find((x) => x.id === body.id);
    if (!p) return sendError(res, 400, `unknown participant id "${body.id}"`);

    // human参加者にはmodel/effort/pcAccessいずれも無意味なので、無視して現状のstateを返す（400にはしない）
    if (p.adapter === 'human') {
      return sendJson(res, 200, buildStateResponse());
    }

    /** @type {Record<string, string|undefined>} */
    const patch = {};

    if ('model' in body) {
      const r = normalizeFieldUpdate(body.model);
      if (r.action === 'invalid') {
        return sendError(res, 400, 'model must be a non-empty string, or null/"" to clear it');
      }
      patch.model = r.action === 'delete' ? undefined : r.value;
    }

    if ('effort' in body) {
      const r = normalizeFieldUpdate(body.effort);
      if (r.action === 'invalid') {
        return sendError(res, 400, 'effort must be a non-empty string, or null/"" to clear it');
      }
      patch.effort = r.action === 'delete' ? undefined : r.value;
    }

    if ('pcAccess' in body) {
      if (CLI_ADAPTER_NAMES.includes(p.adapter)) {
        if (body.pcAccess !== 'read' && body.pcAccess !== 'full') {
          return sendError(res, 400, 'pcAccess must be "read" or "full"');
        }
        patch.pcAccess = body.pcAccess;
      }
      // CLI系アダプタ以外（ollama/openai-compat）に指定された場合は無視する
    }

    applyParticipantPatch(p, patch);
    if (currentBoard) {
      const bp = currentBoard.participants.find((x) => x.id === body.id);
      if (bp) {
        // board.participants側も同じ内容にmutateする（ctx.participantが同一参照な
        // ので、次にこの参加者のspeakが呼ばれるターンから自然に反映される。SPEC §2）
        applyParticipantPatch(bp, patch);
        saveBoard(stateDir, currentBoard);
      }
    }
    persistParticipantConfig(body.id, patch);

    broadcast({ type: 'update' });
    return sendJson(res, 200, buildStateResponse());
  }

  /**
   * POST /api/session-rules — その場の共通/個別ルールの部分更新マージ。
   * - `common`: string（""でクリア=削除相当）
   * - `byId`: { <pid>: string }（値""はそのエントリ削除）
   * - common/各エントリとも最大 MAX_SESSION_RULES_CHARS 字。超過・非string・不正pidは400
   * - idle/終了後: 開始前ステージング（sessionRules）へ／実行中: board.meta.rules をmutate＋saveBoard
   *   （エンジンは毎ターン合成し直すので、次にその参加者のspeakが呼ばれるターンから反映される）
   * @param {object} body
   * @param {import('node:http').ServerResponse} res
   */
  function handleSessionRules(body, res) {
    if (!('common' in body) && !('byId' in body)) {
      return sendError(res, 400, 'at least one of common / byId is required');
    }
    // ---- 検証（全部OKになるまで一切適用しない） ----
    let newCommon;
    if ('common' in body) {
      if (typeof body.common !== 'string') {
        return sendError(res, 400, 'common must be a string');
      }
      if (body.common.length > MAX_SESSION_RULES_CHARS) {
        return sendError(res, 400, `common must be at most ${MAX_SESSION_RULES_CHARS} characters`);
      }
      newCommon = body.common;
    }
    /** @type {Array<[string, string]>|null} */
    let byIdEntries = null;
    if ('byId' in body) {
      if (!body.byId || typeof body.byId !== 'object' || Array.isArray(body.byId)) {
        return sendError(res, 400, 'byId must be an object of { participantId: string }');
      }
      byIdEntries = [];
      const knownIds = new Set(
        (currentBoard ? currentBoard.participants : participants).map((p) => p.id)
      );
      for (const [pid, text] of Object.entries(body.byId)) {
        if (!knownIds.has(pid)) {
          return sendError(res, 400, `unknown participant id "${pid}" in byId`);
        }
        if (typeof text !== 'string') {
          return sendError(res, 400, `byId["${pid}"] must be a string`);
        }
        if (text.length > MAX_SESSION_RULES_CHARS) {
          return sendError(
            res,
            400,
            `byId["${pid}"] must be at most ${MAX_SESSION_RULES_CHARS} characters`
          );
        }
        byIdEntries.push([pid, text]);
      }
    }

    // ---- 適用先の決定とマージ ----
    /** @param {{common:string, byId:Object<string,string>}} target */
    const applyTo = (target) => {
      if (newCommon !== undefined) target.common = newCommon;
      if (byIdEntries) {
        for (const [pid, text] of byIdEntries) {
          if (text === '') {
            delete target.byId[pid]; // ""はエントリ削除
          } else {
            target.byId[pid] = text;
          }
        }
      }
    };

    if (isDebateActive()) {
      currentBoard.meta.rules = normalizeRules(currentBoard.meta.rules);
      applyTo(currentBoard.meta.rules);
      saveBoard(stateDir, currentBoard);
    } else {
      applyTo(sessionRules);
    }

    broadcast({ type: 'update' });
    return sendJson(res, 200, buildStateResponse());
  }

  /**
   * POST /api/import-notes — notes.json（持ち運び用）の取り込み。
   * 実行中の議論が無ければ409。
   * - `notes`: { <pid>: string } — 既知の参加者のみ上書きマージ（未知pidはスキップ）
   * - `cards`: [{lane,title,body}] — 既存カードに**追加**（新規ID採番・createdBy="import"）
   * - `summary`: 上書きしない（無視）
   * @param {object} body
   * @param {import('node:http').ServerResponse} res
   */
  function handleImportNotes(body, res) {
    if (!isDebateActive()) {
      return sendError(res, 409, 'no debate in progress to import into');
    }
    if (body.notes !== undefined && (typeof body.notes !== 'object' || body.notes === null || Array.isArray(body.notes))) {
      return sendError(res, 400, 'notes must be an object of { participantId: string }');
    }
    if (body.cards !== undefined && !Array.isArray(body.cards)) {
      return sendError(res, 400, 'cards must be an array');
    }

    if (body.notes) {
      for (const [pid, text] of Object.entries(body.notes)) {
        if (typeof text !== 'string') continue;
        if (!(pid in currentBoard.notes)) continue; // 未知pidはスキップ
        currentBoard.notes[pid] = text;
      }
    }

    if (Array.isArray(body.cards) && body.cards.length > 0) {
      const ops = body.cards
        .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
        .map((c) => ({
          op: 'add',
          lane: c.lane,
          title: c.title,
          body: typeof c.body === 'string' ? c.body : '',
        }));
      // 不正lane・title欠落はapplyCardOpsが弾いてwarningsに積む（採番はcardSeqで自動）
      applyCardOps(currentBoard, ops, 'import');
    }

    saveBoard(stateDir, currentBoard);
    broadcast({ type: 'update' });
    return sendJson(res, 200, buildStateResponse());
  }

  /**
   * POST /api/interject — オーナー（人間）から特定の参加AIへの割り込み依頼。
   * - `{participantId, text}`（text非空・最大4000字。human宛・不明pidは400。議論が一度も無ければ400）
   * - AI発言中（speaking≠null。ただしhumanの入力待ちは除く）は409
   * - 実行中(running)なら一時的にpausedへ（既存pauseゲートが次ターンを止める）→
   *   対象アダプタを1回呼び、結果をtranscriptへ2エントリ（request/reply）追記して
   *   cardOps/noteUpdateを通常どおり適用→runningへ復帰
   * - 元がended/pausedならstatusはそのまま維持（**endedはendedのまま**＝終了後も応答可能）
   * - 実行中は speaking を phase:'interject' にし、onProgress経由のライブ表示も流れる
   * @param {object} body
   * @param {import('node:http').ServerResponse} res
   */
  async function handleInterject(body, res) {
    if (!currentBoard) return sendError(res, 400, 'no debate to interject into');
    if (typeof body.participantId !== 'string' || body.participantId === '') {
      return sendError(res, 400, 'participantId (string) is required');
    }
    const participant = currentBoard.participants.find((p) => p.id === body.participantId);
    if (!participant) return sendError(res, 400, `unknown participant id "${body.participantId}"`);
    if (participant.adapter === 'human') {
      return sendError(res, 400, 'cannot interject a human participant');
    }
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      return sendError(res, 400, 'text (non-empty string) is required');
    }
    if (body.text.length > MAX_INTERJECT_CHARS) {
      return sendError(res, 400, `text must be at most ${MAX_INTERJECT_CHARS} characters`);
    }
    // AIの発言中は409（humanの入力待ち中はエンジンが停止しているので許可＝入力バーと両立）
    const humanWaiting = awaitingHuman && speaking && speaking.participantId === awaitingHuman.participantId;
    if (speaking && !humanWaiting) {
      return sendError(res, 409, '発言が終わってから送ってください');
    }

    const board = currentBoard;
    const requestText = body.text;
    const pid = participant.id;
    const wasRunning = board.meta.status === 'running';
    if (wasRunning) {
      board.meta.status = 'paused'; // 既存pauseゲートで次の通常ターンを待たせる
      saveBoard(stateDir, board);
    }
    const prevSpeaking = speaking;
    speaking = { participantId: pid, round: board.meta.round, phase: 'interject', since: new Date().toISOString() };
    broadcast({ type: 'interject-start', participantId: pid });

    try {
      // 通常ターンと同じ文脈でctxを組み立てる（rulesは本人の個別ルール込み）
      const { entries } = loadTranscript(stateDir, board.meta.id);
      const recentTranscript = entries.slice(-10);
      const rules = composeRulesFor(board.meta.rules, pid);
      const ownNote = board.notes[pid] ?? '';
      const promptText = buildInterjectPrompt({
        participant,
        topic: board.meta.topic,
        board,
        ownNote,
        recentTranscript,
        rules,
        requestText,
      });
      const ctx = {
        participant,
        topic: board.meta.topic,
        round: board.meta.round,
        maxRounds: board.meta.maxRounds,
        boardSummary: boardSummary(board),
        ownNote,
        recentTranscript,
        rules,
        schemaJson: TURN_SCHEMA,
        promptText,
        prompt: promptText,
        interject: true,
      };

      // pauseゲートは通さない（この呼び出し自体が意図的な割り込みのため）。進捗配信は通常どおり
      const inner =
        injectedAdapters && injectedAdapters[pid]
          ? injectedAdapters[pid]
          : { speak: resolveAdapter(participant.adapter) };
      const adapter = withProgress(inner, pid);

      let result;
      try {
        result = await adapter.speak(ctx);
      } catch (err) {
        result = { pass: true, error: err?.message ?? String(err) };
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        result = { pass: true, error: 'invalid TurnResult: not an object' };
      }
      const utterance = typeof result.utterance === 'string' ? result.utterance : '';
      const { applied, warnings } = applyCardOps(board, Array.isArray(result.cardOps) ? result.cardOps : [], pid);
      if (typeof result.noteUpdate === 'string') {
        board.notes[pid] = result.noteUpdate;
      }

      // transcriptへ request / reply の2エントリ追記
      appendTranscript(stateDir, board.meta.id, {
        round: board.meta.round,
        participantId: 'owner',
        utterance: requestText,
        interject: 'request',
        targetId: pid,
      });
      appendTranscript(stateDir, board.meta.id, {
        round: board.meta.round,
        participantId: pid,
        utterance,
        pass: !!result.pass,
        cardOps: applied,
        warnings,
        error: result.error ?? null,
        interject: 'reply',
      });
      saveBoard(stateDir, board);
    } finally {
      speaking = prevSpeaking ?? null;
      // runningから一時pausedにした場合のみ復帰（元がended/pausedならそのまま維持）
      if (wasRunning && board.meta.status === 'paused') {
        board.meta.status = 'running';
        saveBoard(stateDir, board);
      }
    }

    broadcast({ type: 'update' });
    return sendJson(res, 200, buildStateResponse());
  }

  function handleCard(body, res) {
    if (!currentBoard) return sendError(res, 400, 'no debate in progress');
    if (typeof body.op !== 'string') return sendError(res, 400, 'op is required');
    const byId = findHumanId();
    // warningsを握りつぶさない: 不正op（title欠落・存在しないcardId等）は適用されずに
    // warningsへ積まれるので、応答に含めてGUIが警告トーストを出せるようにする（200のまま）
    const { warnings } = applyCardOps(currentBoard, [body], byId);
    saveBoard(stateDir, currentBoard);
    broadcast({ type: 'update' });
    const response = buildStateResponse();
    if (warnings.length > 0) response.warnings = warnings;
    return sendJson(res, 200, response);
  }

  function handleSay(body, res) {
    if (!awaitingHuman) return sendError(res, 400, 'no human turn is pending');
    if (typeof body.text !== 'string') return sendError(res, 400, 'text (string) is required');
    resolvePendingHuman({ text: body.text });
    broadcast({ type: 'update' });
    return sendJson(res, 200, buildStateResponse());
  }

  function handleSkip(_body, res) {
    if (!awaitingHuman) return sendError(res, 400, 'no human turn is pending');
    resolvePendingHuman({ skip: true });
    broadcast({ type: 'update' });
    return sendJson(res, 200, buildStateResponse());
  }

  function handleNote(body, res) {
    if (!currentBoard) return sendError(res, 400, 'no debate in progress');
    if (typeof body.text !== 'string') return sendError(res, 400, 'text (string) is required');
    const humanId = findHumanId();
    if (!(humanId in currentBoard.notes)) {
      return sendError(res, 400, 'no human participant in this debate');
    }
    currentBoard.notes[humanId] = body.text;
    saveBoard(stateDir, currentBoard);
    broadcast({ type: 'update' });
    return sendJson(res, 200, buildStateResponse());
  }

  return server;
}

// 直接実行: `node src/server.mjs` — loadConfigして 127.0.0.1:config.port で起動
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootDir = path.join(__dirname, '..');
  const config = loadConfig(rootDir);
  const server = createServer({ config, stateDir: path.join(rootDir, 'state') });
  server.on('error', (err) => {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EADDRINUSE') {
      console.error(`ポート ${config.port} は使用中です。別の debate-board が起動していないか確認してください。`);
      console.error(`  確認(Windows): Get-NetTCPConnection -LocalPort ${config.port} -State Listen`);
      console.error(`  または config.json の "port" を変更して再起動してください。`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`debate-board listening on http://127.0.0.1:${config.port}`);
  });
}
