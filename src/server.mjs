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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_INDEX = path.join(__dirname, '..', 'public', 'index.html');

/** POSTボディの上限（暴走・DoS対策のガード。ローカル専用アプリなので大きめでよい）。 */
const MAX_BODY_BYTES = 1024 * 1024;

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
 * @returns {import('node:http').Server}
 */
export function createServer({ config, adapters: injectedAdapters, stateDir = 'state' } = {}) {
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
    return list.map((p) => ({ id: p.id, name: p.name, adapter: p.adapter, enabled: p.enabled }));
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
          meta: { topic: '', round: 0, maxRounds: config.maxRounds, status: 'idle', endedBy: null },
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
   */
  function startDebate(topic, maxRounds) {
    const board = createDebate(stateDir, topic, { maxRounds, participants });
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

    const postRoutes = {
      '/api/start': handleStart,
      '/api/pause': handlePause,
      '/api/end': handleEnd,
      '/api/toggle': handleToggle,
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
    const enabledCount = participants.filter((p) => p.enabled).length;
    if (enabledCount < 2) {
      return sendError(res, 400, 'at least 2 enabled participants are required to start');
    }
    startDebate(body.topic, maxRounds);
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
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`debate-board listening on http://127.0.0.1:${config.port}`);
  });
}
