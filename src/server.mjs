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
import { createDebate, saveBoard, applyCardOps, loadTranscript } from './state.mjs';
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

/** POST /api/rules の基本ルール（baseRules）の最大文字数。超過は400。 */
const MAX_BASE_RULES_CHARS = 8000;

/** POSTボディの上限（暴走・DoS対策のガード。ローカル専用アプリなので大きめでよい）。 */
const MAX_BODY_BYTES = 1024 * 1024;

/** POST /api/participant で model/effort/pcAccess を変更できるアダプタ種別（CLI系のみ）。 */
const CLI_ADAPTER_NAMES = ['claude', 'codex', 'grok'];

/** GET /api/options の発見結果メモリキャッシュのTTL。 */
const OPTIONS_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * 参加AIの行動ルールを合成する（合成はサーバ/CLI側の責務。engine/stateはfsを読まない）。
 * 基本ルールは rulesPath（PARTICIPANT_RULES.md）から**開始のたびに**読む
 * （＝ファイル編集が次の議論から反映される）。ファイルが無ければ空として扱う。
 * 追加ルール（extraRules）が非空なら「## 今回の追加ルール」見出しで結合する。
 * @param {string} rulesPath
 * @param {string} [extraRules]
 * @returns {string}
 */
export function composeRules(rulesPath, extraRules) {
  let base = '';
  try {
    base = fs.readFileSync(rulesPath, 'utf8').trim();
  } catch {
    base = '';
  }
  const extra = typeof extraRules === 'string' ? extraRules.trim() : '';
  if (base && extra) return `${base}\n\n## 今回の追加ルール\n${extra}`;
  if (base) return base;
  if (extra) return `## 今回の追加ルール\n${extra}`;
  return '';
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

  /** @param {object} participant */
  function buildAdapterFor(participant) {
    if (injectedAdapters && injectedAdapters[participant.id]) {
      return withPauseGate(injectedAdapters[participant.id]);
    }
    if (participant.adapter === 'human') {
      return withPauseGate(makeHuman(humanBridge));
    }
    return withPauseGate({ speak: resolveAdapter(participant.adapter) });
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
      };
    });
  }

  /** SPEC §8 の GET /api/state 応答形を組み立てる */
  function buildStateResponse() {
    if (!currentBoard) {
      return {
        board: {
          meta: { topic: '', round: 0, maxRounds: config.maxRounds, status: 'idle', endedBy: null, rules: '' },
          cards: [],
          notes: {},
          summary: null,
        },
        participants: currentParticipantsView(),
        awaitingHuman,
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
          rules: typeof currentBoard.meta.rules === 'string' ? currentBoard.meta.rules : '',
        },
        cards: currentBoard.cards,
        notes: currentBoard.notes,
        summary: currentBoard.summary,
      },
      participants: currentParticipantsView(),
      awaitingHuman,
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
    if (event.type === 'ended') {
      // 'update'も併せて流す: GUI側の既存ハンドラ（update時に/api/state再取得）だけでも
      // summaryが反映されるようにするための保険（'ended'固有ハンドラが無くても壊れない）
      broadcast({ type: 'update' });
      broadcast({ type: 'ended' });
      return;
    }
    // 'turn' / 'warning' いずれも「boardが変わったので再取得してね」の合図
    broadcast({ type: 'update' });
  }

  /**
   * @param {string} topic
   * @param {number} maxRounds
   * @param {string} [extraRules] - 開始時の追加ルール（基本ルールファイルと合成される）
   */
  function startDebate(topic, maxRounds, extraRules) {
    // 基本ルールはstart時に毎回ファイルから読む（編集が次の議論から反映される）
    const rules = composeRules(rulesPath, extraRules);
    const board = createDebate(stateDir, topic, { maxRounds, rules, participants });
    currentBoard = board;

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
      if (req.method === 'GET') return serveRules(res);
      if (req.method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendError(res, 400, err.message);
        }
        return handleRulesPost(body, res);
      }
      return sendError(res, 405, 'method not allowed');
    }

    const postRoutes = {
      '/api/start': handleStart,
      '/api/pause': handlePause,
      '/api/end': handleEnd,
      '/api/toggle': handleToggle,
      '/api/participant': handleParticipant,
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
   * GET /api/rules — 基本ルールファイル（rulesPath=PARTICIPANT_RULES.md）の現在の中身を返す。
   * 毎回ファイルから読む（キャッシュしない）。ファイルが無ければ baseRules は ""。
   * @param {import('node:http').ServerResponse} res
   */
  function serveRules(res) {
    let baseRules = '';
    try {
      baseRules = fs.readFileSync(rulesPath, 'utf8');
    } catch {
      baseRules = '';
    }
    return sendJson(res, 200, { baseRules });
  }

  /**
   * POST /api/rules — 基本ルールファイルを書き換える。
   * saveBoard同様、tmpファイル→renameSync で原子的に書き込む。
   * **実行中の議論には影響しない**: board.meta.rules は開始時に合成・固定されるため、
   * ここでの変更は次の /api/start（または CLI 実行）から反映される。
   * @param {object} body
   * @param {import('node:http').ServerResponse} res
   */
  function handleRulesPost(body, res) {
    if (typeof body.baseRules !== 'string') {
      return sendError(res, 400, 'baseRules (string) is required');
    }
    if (body.baseRules.length > MAX_BASE_RULES_CHARS) {
      return sendError(res, 400, `baseRules must be at most ${MAX_BASE_RULES_CHARS} characters`);
    }
    const dir = path.dirname(rulesPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${rulesPath}.tmp`;
    fs.writeFileSync(tmp, body.baseRules, 'utf8');
    fs.renameSync(tmp, rulesPath);
    return sendJson(res, 200, { baseRules: body.baseRules });
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
    startDebate(body.topic, maxRounds, extraRules);
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

  function handleCard(body, res) {
    if (!currentBoard) return sendError(res, 400, 'no debate in progress');
    if (typeof body.op !== 'string') return sendError(res, 400, 'op is required');
    const byId = findHumanId();
    applyCardOps(currentBoard, [body], byId);
    saveBoard(stateDir, currentBoard);
    broadcast({ type: 'update' });
    return sendJson(res, 200, buildStateResponse());
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
