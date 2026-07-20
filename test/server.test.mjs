/**
 * test/server.test.mjs — node:test による src/server.mjs の結線テスト。
 * ダミーお題「きのこ vs たけのこ」のみ使用（実議論内容は書かない）。
 * フェイクアダプタ注入＋ephemeralポートで実行する。実CLIは一切呼ばない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createServer } from '../src/server.mjs';
import {
  parseCodexModelsCache,
  parseGrokModelsOutput,
  parseOllamaTags,
  parseOpenAiModels,
  discoverAdapterOptions,
  STATIC_OPTIONS,
} from '../src/options.mjs';

const TOPIC = 'きのこ vs たけのこ';

function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-server-test-'));
}

/**
 * フェイクの非human参加者アダプタ。呼び出し1回目は発言＋（任意で）カード追加、
 * 2回目以降はpass:trueにして議論の終了条件（allPass）に到達できるようにする。
 */
function fakeSpeaker(label, { addCardOnFirstTurn = false } = {}) {
  let turn = 0;
  return {
    async speak(ctx) {
      turn += 1;
      const cardOps =
        addCardOnFirstTurn && turn === 1
          ? [{ op: 'add', cardId: null, lane: 'decided', title: `${label}の結論`, body: 'テスト用カード', }]
          : [];
      return {
        utterance: `${label}のR${ctx.round}発言`,
        cardOps,
        noteUpdate: null,
        pass: turn >= 2,
        error: null,
      };
    },
  };
}

function defaultParticipants() {
  return [
    { id: 'a', name: 'A', adapter: 'claude', enabled: true },
    { id: 'b', name: 'B', adapter: 'codex', enabled: true },
    { id: 'you', name: 'あなた', adapter: 'human', enabled: true },
  ];
}

/**
 * @param {import('node:test').TestContext} t
 * @param {object} [configOverrides]
 */
async function startTestServer(t, configOverrides = {}) {
  const stateDir = makeStateDir();
  const config = {
    port: 0,
    maxRounds: 2,
    participants: defaultParticipants(),
    ...configOverrides,
  };
  const adapters = {
    a: fakeSpeaker('A', { addCardOnFirstTurn: true }),
    b: fakeSpeaker('B'),
  };
  const server = createServer({ config, adapters, stateDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  /** @type {Array<import('node:http').ClientRequest>} */
  const sseReqs = [];
  // node:http's server.close() only fires its callback once every open socket
  // ends — a live keep-alive SSE stream would otherwise hang it forever, so
  // every SSE connection opened via connectSSE() must be destroyed first.
  t.after(
    () =>
      new Promise((resolve) => {
        for (const req of sseReqs) {
          try {
            req.destroy();
          } catch {
            /* already closed */
          }
        }
        server.close(() => resolve());
      })
  );
  return { baseUrl, stateDir, server, connectSSE: (path) => connectSSE(`${baseUrl}${path}`, sseReqs) };
}

function getJson(url) {
  return fetch(url).then((r) => r.json().then((body) => ({ status: r.status, body })));
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json().then((json) => ({ status: r.status, body: json })).catch(() => ({ status: r.status, body: null })));
}

/**
 * SSEストリームに接続し、受信済みイベントを配列として貯めておく簡易ヘルパー。
 * `tracked` を渡すとreqをそこに積み、呼び出し側（startTestServer）がテスト終了時に
 * まとめて破棄できるようにする。
 */
function connectSSE(url, tracked) {
  const events = [];
  const req = http.get(url, (res) => {
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = raw.split('\n').find((l) => l.startsWith('data:'));
        if (line) {
          try {
            events.push(JSON.parse(line.slice(5).trim()));
          } catch {
            // コメント/ping行は無視
          }
        }
      }
    });
  });
  req.on('error', () => {});
  if (tracked) tracked.push(req);
  return { req, events };
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 30 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: timed out waiting for condition');
}

test('start -> state -> SSE update -> card -> say/skip -> end -> summary', async (t) => {
  const { baseUrl, connectSSE: connect } = await startTestServer(t);

  const idle = await getJson(`${baseUrl}/api/state`);
  assert.equal(idle.status, 200);
  assert.equal(idle.body.board.meta.status, 'idle');
  assert.equal(idle.body.participants.length, 3);

  const sse = connect('/api/events');

  const startRes = await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 2 });
  assert.equal(startRes.status, 200);
  assert.equal(startRes.body.board.meta.status, 'running');
  assert.equal(startRes.body.board.meta.topic, TOPIC);

  // ラウンド1: a→b→you の順。humanの番でawaitingHumanがSSE経由で届く
  await waitFor(() => sse.events.some((e) => e.type === 'await-human'));
  const state1 = await getJson(`${baseUrl}/api/state`);
  assert.ok(state1.body.awaitingHuman);
  assert.equal(state1.body.awaitingHuman.participantId, 'you');
  // Aの1ターン目のcardOpsがすでに反映されている
  assert.ok(state1.body.board.cards.some((c) => c.title === 'Aの結論'));
  // transcriptにA/Bの発言が正規化されて載っている（utterance -> text, name -> speaker）
  assert.ok(state1.body.transcript.some((e) => e.speaker === 'A' && e.text.includes('R1')));

  const sayRes = await postJson(`${baseUrl}/api/say`, { text: '人間の発言です' });
  assert.equal(sayRes.status, 200);
  assert.equal(sayRes.body.awaitingHuman, null);

  // ラウンド2でもう一度human待ちが来るのでskipで解決する
  await waitFor(() => sse.events.filter((e) => e.type === 'await-human').length >= 2);
  const skipRes = await postJson(`${baseUrl}/api/skip`, {});
  assert.equal(skipRes.status, 200);

  // A/Bが2ターン目でpass:trueを返すのでallPassにより終了する
  await waitFor(() => sse.events.some((e) => e.type === 'ended'));
  const finalState = await getJson(`${baseUrl}/api/state`);
  assert.equal(finalState.body.board.meta.status, 'ended');
  assert.equal(finalState.body.board.meta.endedBy, 'allPass');
  assert.ok(typeof finalState.body.board.summary === 'string' && finalState.body.board.summary.length > 0);

  // カード直接操作
  const cardRes = await postJson(`${baseUrl}/api/card`, {
    op: 'add',
    lane: 'held',
    title: '追加カード',
    body: '',
  });
  assert.equal(cardRes.status, 200);
  assert.ok(cardRes.body.board.cards.some((c) => c.title === '追加カード'));
});

test('進行中の再startは409', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const first = await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 2 });
  assert.equal(first.status, 200);
  const second = await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 2 });
  assert.equal(second.status, 409);
});

test('ON参加者2人未満のstartは400', async (t) => {
  const { baseUrl } = await startTestServer(t, {
    participants: [
      { id: 'a', name: 'A', adapter: 'claude', enabled: true },
      { id: 'b', name: 'B', adapter: 'codex', enabled: false },
    ],
  });
  const res = await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 2 });
  assert.equal(res.status, 400);
});

test('pauseはrunning<->pausedをトグルする', async (t) => {
  const { baseUrl } = await startTestServer(t);
  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 5 });
  const paused = await postJson(`${baseUrl}/api/pause`, {});
  assert.equal(paused.status, 200);
  assert.equal(paused.body.board.meta.status, 'paused');
  const resumed = await postJson(`${baseUrl}/api/pause`, {});
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.board.meta.status, 'running');
});

test('toggleはboard未開始でも参加者一覧を更新する', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const res = await postJson(`${baseUrl}/api/toggle`, { id: 'you', enabled: false });
  assert.equal(res.status, 200);
  const you = res.body.participants.find((p) => p.id === 'you');
  assert.equal(you.enabled, false);
});

test('未知パスは404, 不正メソッドは405, 不正JSONは400', async (t) => {
  const { baseUrl } = await startTestServer(t);

  const r404 = await fetch(`${baseUrl}/api/nope`);
  assert.equal(r404.status, 404);

  const r405 = await fetch(`${baseUrl}/api/state`, { method: 'POST' });
  assert.equal(r405.status, 405);

  const rBadJson = await fetch(`${baseUrl}/api/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not valid json',
  });
  assert.equal(rBadJson.status, 400);
});

test('humanターン待機中のendは保留Promiseを即解決して速やかに終了する', async (t) => {
  const { baseUrl, connectSSE: connect } = await startTestServer(t);
  const sse = connect('/api/events');

  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 5 });
  await waitFor(() => sse.events.some((e) => e.type === 'await-human'));

  const endRes = await postJson(`${baseUrl}/api/end`, {});
  assert.equal(endRes.status, 200);
  assert.equal(endRes.body.awaitingHuman, null);

  // humanタイムアウト(5分)を待たされることなく即座にendedになる
  await waitFor(() => sse.events.some((e) => e.type === 'ended'), { timeoutMs: 3000 });
  const finalState = await getJson(`${baseUrl}/api/state`);
  assert.equal(finalState.body.board.meta.status, 'ended');
  assert.equal(finalState.body.board.meta.endedBy, 'ending');
});

test('pause中のendでもhuman保留が解決され終了する', async (t) => {
  const { baseUrl, connectSSE: connect } = await startTestServer(t);
  const sse = connect('/api/events');

  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 5 });
  await waitFor(() => sse.events.some((e) => e.type === 'await-human'));

  const paused = await postJson(`${baseUrl}/api/pause`, {});
  assert.equal(paused.body.board.meta.status, 'paused');

  const endRes = await postJson(`${baseUrl}/api/end`, {});
  assert.equal(endRes.status, 200);

  await waitFor(() => sse.events.some((e) => e.type === 'ended'), { timeoutMs: 3000 });
  const finalState = await getJson(`${baseUrl}/api/state`);
  assert.equal(finalState.body.board.meta.status, 'ended');
  assert.equal(finalState.body.board.meta.endedBy, 'ending');
});

test('マルチバイトUTF-8がチャンク境界で分断されても正しくパースされる', async (t) => {
  const { baseUrl } = await startTestServer(t);
  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 5 });

  const title = 'たけのこ派の勝利条件🍄';
  const payload = Buffer.from(
    JSON.stringify({ op: 'add', lane: 'discussing', title, body: '日本語本文テスト' }),
    'utf8'
  );
  // マルチバイト文字の途中（「た」= 3バイトの2バイト目）で分割し、生チャンクとして送信する
  const splitAt = payload.indexOf(Buffer.from('た', 'utf8')) + 1;
  assert.ok(splitAt > 0, 'テスト前提: ペイロード内に「た」が存在すること');
  const chunk1 = payload.subarray(0, splitAt);
  const chunk2 = payload.subarray(splitAt);

  const url = new URL(`${baseUrl}/api/card`);
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(chunk1);
    // 2チャンク目を別tickで送り、サーバ側で確実に複数の'data'イベントに分かれるようにする
    setTimeout(() => {
      req.write(chunk2);
      req.end();
    }, 20);
  });

  assert.equal(result.status, 200);
  const card = result.body.board.cards.find((c) => c.title === title);
  assert.ok(card, 'マルチバイトタイトルのカードが化けずに保存されていること');
  assert.equal(card.body, '日本語本文テスト');
  assert.ok(!JSON.stringify(result.body.board.cards).includes('�'), '置換文字(U+FFFD)が混入していないこと');
});

test('POST /api/participant: model/effort/pcAccessを更新できる', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const res = await postJson(`${baseUrl}/api/participant`, {
    id: 'a',
    model: 'opus',
    effort: 'high',
    pcAccess: 'full',
  });
  assert.equal(res.status, 200);
  const a = res.body.participants.find((p) => p.id === 'a');
  assert.equal(a.model, 'opus');
  assert.equal(a.effort, 'high');
  assert.equal(a.pcAccess, 'full');
});

test('POST /api/participant: null/空文字でフィールドが削除される（CLI既定への復帰）', async (t) => {
  const { baseUrl } = await startTestServer(t);
  await postJson(`${baseUrl}/api/participant`, { id: 'a', model: 'opus', effort: 'high' });
  const res = await postJson(`${baseUrl}/api/participant`, { id: 'a', model: null, effort: '' });
  assert.equal(res.status, 200);
  const a = res.body.participants.find((p) => p.id === 'a');
  assert.equal(a.model, null);
  assert.equal(a.effort, null);
});

test('POST /api/participant: 不正idは400', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const res = await postJson(`${baseUrl}/api/participant`, { id: 'nope', model: 'opus' });
  assert.equal(res.status, 400);
});

test('POST /api/participant: 不正pcAccessは400', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const res = await postJson(`${baseUrl}/api/participant`, { id: 'a', pcAccess: 'sudo' });
  assert.equal(res.status, 400);
});

test('POST /api/participant: human参加者は無視されて400にならない', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const res = await postJson(`${baseUrl}/api/participant`, { id: 'you', model: 'opus', pcAccess: 'full' });
  assert.equal(res.status, 200);
  const you = res.body.participants.find((p) => p.id === 'you');
  assert.equal(you.model, null);
  assert.equal(you.pcAccess, null);
});

test('POST /api/participant: CLI系以外(ollama)のpcAccessは無視される（400にもならない）', async (t) => {
  const { baseUrl } = await startTestServer(t, {
    participants: [
      { id: 'a', name: 'A', adapter: 'claude', enabled: true },
      { id: 'local', name: 'ローカル', adapter: 'ollama', endpoint: 'http://127.0.0.1:11434', enabled: true },
    ],
  });
  const res = await postJson(`${baseUrl}/api/participant`, { id: 'local', model: 'qwen3', pcAccess: 'full' });
  assert.equal(res.status, 200);
  const local = res.body.participants.find((p) => p.id === 'local');
  assert.equal(local.model, 'qwen3'); // modelは適用される
  assert.equal(local.pcAccess, null); // pcAccessは無視される（CLI系以外）
});

test('POST /api/participant: configPathへ永続化される（リポ本体のconfig.jsonは汚さない）', async (t) => {
  const stateDir = makeStateDir();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-configpath-test-'));
  const configPath = path.join(configDir, 'config.json');
  const config = { port: 0, maxRounds: 2, participants: defaultParticipants() };
  const adapters = { a: fakeSpeaker('A'), b: fakeSpeaker('B') };
  const server = createServer({ config, adapters, stateDir, configPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(() => resolve())));

  const res = await postJson(`${baseUrl}/api/participant`, {
    id: 'a',
    model: 'opus',
    effort: 'high',
    pcAccess: 'full',
  });
  assert.equal(res.status, 200);

  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const a = saved.participants.find((p) => p.id === 'a');
  assert.equal(a.model, 'opus');
  assert.equal(a.effort, 'high');
  assert.equal(a.pcAccess, 'full');
  // 他の参加者は変更されていない
  const b = saved.participants.find((p) => p.id === 'b');
  assert.equal(b.model, undefined);
});

test('POST /api/participant: 実行中の議論のboard.participantsにも次ターンから反映される', async (t) => {
  const stateDir = makeStateDir();
  const config = { port: 0, maxRounds: 3, participants: defaultParticipants() };
  const seenModels = [];
  const adapters = {
    a: {
      async speak(ctx) {
        seenModels.push(ctx.participant.model ?? null);
        return {
          utterance: `AのR${ctx.round}発言`,
          cardOps: [],
          noteUpdate: null,
          pass: seenModels.length >= 2,
          error: null,
        };
      },
    },
    b: fakeSpeaker('B'),
  };
  const server = createServer({ config, adapters, stateDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const sseReqs = [];
  t.after(
    () =>
      new Promise((resolve) => {
        for (const req of sseReqs) {
          try {
            req.destroy();
          } catch {
            /* already closed */
          }
        }
        server.close(() => resolve());
      })
  );
  const sse = connectSSE(`${baseUrl}/api/events`, sseReqs);

  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 3 });
  // ラウンド1完了後、humanの番でawaitingHumanが立つ（a/bはすでにR1で発言済み）
  await waitFor(() => sse.events.some((e) => e.type === 'await-human'));
  assert.equal(seenModels[0], null); // R1時点ではまだ未設定

  const patchRes = await postJson(`${baseUrl}/api/participant`, { id: 'a', model: 'opus' });
  assert.equal(patchRes.status, 200);

  await postJson(`${baseUrl}/api/skip`, {}); // ラウンド2へ進める
  await waitFor(() => seenModels.length >= 2);
  assert.equal(seenModels[1], 'opus'); // ラウンド2以降のspeak呼び出しに新しいmodelが渡る
});

// --------------------------------------------------------------------
// GET /api/options（候補の自動発見）
// --------------------------------------------------------------------

test('parseCodexModelsCache: models[].slug を抽出する（実ファイル形フィクスチャ）', () => {
  const fixture = JSON.stringify({
    models: [
      { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', default_reasoning_effort: 'medium' },
      { slug: 'gpt-5.6-mini', display_name: 'GPT-5.6 Mini' },
      { display_name: 'slugなしは無視される' },
      { slug: '' },
    ],
  });
  assert.deepEqual(parseCodexModelsCache(fixture), ['gpt-5.6-luna', 'gpt-5.6-mini']);
});

test('parseCodexModelsCache: 不正JSON・models欠落はthrowする', () => {
  assert.throws(() => parseCodexModelsCache('{not json'));
  assert.throws(() => parseCodexModelsCache('{"foo": 1}'));
  assert.throws(() => parseCodexModelsCache('null'));
});

test('parseGrokModelsOutput: Available models: 以降の * 行から抽出し (default) 注記を除去する', () => {
  const stdout = 'なにかのヘッダ\nAvailable models:\n  * grok-4.5 (default)\n  * grok-4\n  * grok-3-mini\n';
  assert.deepEqual(parseGrokModelsOutput(stdout), ['grok-4.5', 'grok-4', 'grok-3-mini']);
});

test('parseGrokModelsOutput: マーカーが無い・空出力は空配列', () => {
  assert.deepEqual(parseGrokModelsOutput(''), []);
  assert.deepEqual(parseGrokModelsOutput('* grok-4.5'), []); // マーカーより前の行は対象外
  assert.deepEqual(parseGrokModelsOutput('Available models:\n(none)'), []);
});

test('parseOllamaTags / parseOpenAiModels: 応答からモデル名を抽出、形不正は空配列', () => {
  assert.deepEqual(parseOllamaTags({ models: [{ name: 'qwen3:8b' }, { name: 'llama3' }, {}] }), ['qwen3:8b', 'llama3']);
  assert.deepEqual(parseOllamaTags({}), []);
  assert.deepEqual(parseOpenAiModels({ data: [{ id: 'local-model' }, { id: '' }] }), ['local-model']);
  assert.deepEqual(parseOpenAiModels(null), []);
});

test('discoverAdapterOptions: 全発見が失敗しても静的フォールバックで解決する（throwしない）', async () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-options-home-')); // .codexなし
  const result = await discoverAdapterOptions({
    config: {
      port: 0,
      maxRounds: 2,
      participants: [
        { id: 'a', name: 'A', adapter: 'claude', enabled: true },
        { id: 'local', name: 'L', adapter: 'ollama', endpoint: 'http://127.0.0.1:1', enabled: false },
        { id: 'oai', name: 'O', adapter: 'openai-compat', endpoint: 'http://127.0.0.1:1', enabled: false },
      ],
    },
    homedir: emptyHome,
    runProcessImpl: async () => ({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: new Error('ENOENT') }),
    resolveCommandImpl: (c) => c,
    fetchImpl: async () => { throw new Error('connection refused'); },
  });
  assert.deepEqual(result.adapters.claude, STATIC_OPTIONS.claude);
  assert.deepEqual(result.adapters.codex, STATIC_OPTIONS.codex);
  assert.deepEqual(result.adapters.grok, STATIC_OPTIONS.grok);
  assert.deepEqual(result.adapters.ollama.models, []);
  assert.deepEqual(result.adapters['openai-compat'].models, []);
});

test('discoverAdapterOptions: 注入実装から実環境相当の候補を発見する', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-options-home2-'));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.codex', 'models_cache.json'),
    JSON.stringify({ models: [{ slug: 'gpt-5.6-luna' }, { slug: 'gpt-5.6-mini' }] }),
    'utf8'
  );
  const result = await discoverAdapterOptions({
    config: {
      port: 0,
      maxRounds: 2,
      participants: [
        { id: 'local', name: 'L', adapter: 'ollama', endpoint: 'http://127.0.0.1:11434/', enabled: false },
      ],
    },
    homedir: home,
    runProcessImpl: async () => ({
      code: 0,
      stdout: 'Available models:\n  * grok-4.5 (default)\n  * grok-4\n',
      stderr: '',
      timedOut: false,
      spawnError: null,
    }),
    resolveCommandImpl: (c) => c,
    fetchImpl: async (url) => {
      assert.equal(url, 'http://127.0.0.1:11434/api/tags'); // endpoint末尾スラッシュが正規化される
      return { ok: true, json: async () => ({ models: [{ name: 'qwen3:8b' }] }) };
    },
  });
  assert.deepEqual(result.adapters.codex.models, ['gpt-5.6-luna', 'gpt-5.6-mini']);
  assert.deepEqual(result.adapters.grok.models, ['grok-4.5', 'grok-4']);
  assert.deepEqual(result.adapters.ollama.models, ['qwen3:8b']);
  // effortsは常に静的定義
  assert.deepEqual(result.adapters.codex.efforts, STATIC_OPTIONS.codex.efforts);
});

test('GET /api/options: 注入した発見関数の結果を200で返し、2回目はキャッシュされる', async (t) => {
  let calls = 0;
  const fakeOptions = {
    adapters: {
      claude: { models: ['sonnet', 'opus'], efforts: ['low', 'high'] },
      codex: { models: ['gpt-5.6-luna'], efforts: ['medium'] },
      grok: { models: ['grok-4.5'], efforts: ['low'] },
      ollama: { models: [], efforts: [] },
      'openai-compat': { models: [], efforts: [] },
    },
  };
  const stateDir = makeStateDir();
  const config = { port: 0, maxRounds: 2, participants: defaultParticipants() };
  const server = createServer({
    config,
    adapters: { a: fakeSpeaker('A'), b: fakeSpeaker('B') },
    stateDir,
    discoverOptions: async () => {
      calls += 1;
      return fakeOptions;
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(() => resolve())));

  const first = await getJson(`${baseUrl}/api/options`);
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body.adapters).sort(), ['claude', 'codex', 'grok', 'ollama', 'openai-compat']);
  assert.deepEqual(first.body.adapters.claude.models, ['sonnet', 'opus']);

  const second = await getJson(`${baseUrl}/api/options`);
  assert.equal(second.status, 200);
  assert.equal(calls, 1); // 10分TTL内はメモリキャッシュから返る
});

test('GET /api/options: 発見関数がthrowしても静的フォールバックで200', async (t) => {
  const stateDir = makeStateDir();
  const config = { port: 0, maxRounds: 2, participants: defaultParticipants() };
  const server = createServer({
    config,
    adapters: { a: fakeSpeaker('A'), b: fakeSpeaker('B') },
    stateDir,
    discoverOptions: async () => {
      throw new Error('discovery exploded');
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(() => resolve())));

  const res = await getJson(`${baseUrl}/api/options`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.adapters).sort(), ['claude', 'codex', 'grok', 'ollama', 'openai-compat']);
  assert.deepEqual(res.body.adapters.claude.models, STATIC_OPTIONS.claude.models);
});

// --------------------------------------------------------------------
// /api/start の rules（参加AIルールの合成・注入）
// --------------------------------------------------------------------

/** rulesPath を注入できる素のテストサーバ起動ヘルパー */
async function startServerWithRulesPath(t, rulesPath, extraCreateOpts = {}) {
  const stateDir = makeStateDir();
  const config = { port: 0, maxRounds: 2, participants: defaultParticipants() };
  const adapters = { a: fakeSpeaker('A'), b: fakeSpeaker('B') };
  const server = createServer({ config, adapters, stateDir, rulesPath, ...extraCreateOpts });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return { baseUrl, stateDir };
}

test('POST /api/start: rules指定でPARTICIPANT_RULES.md（rulesPath）と合成されstateに反映される', async (t) => {
  const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-rules-test-'));
  const rulesPath = path.join(rulesDir, 'PARTICIPANT_RULES.md');
  fs.writeFileSync(rulesPath, '# 基本ルール（テスト用）\n- ダミー基本ルール1\n', 'utf8');

  const { baseUrl } = await startServerWithRulesPath(t, rulesPath);
  const res = await postJson(`${baseUrl}/api/start`, {
    topic: TOPIC,
    maxRounds: 2,
    rules: '今回だけのダミー追加ルール',
  });
  assert.equal(res.status, 200);
  const rules = res.body.board.meta.rules;
  assert.ok(rules.includes('ダミー基本ルール1'));
  assert.ok(rules.includes('## 今回の追加ルール'));
  assert.ok(rules.includes('今回だけのダミー追加ルール'));
  // 合成形式: 基本 + "\n\n## 今回の追加ルール\n" + 追加
  assert.ok(rules.indexOf('ダミー基本ルール1') < rules.indexOf('## 今回の追加ルール'));

  // GET /api/state でも同じrulesが返る
  const state = await getJson(`${baseUrl}/api/state`);
  assert.equal(state.body.board.meta.rules, rules);
});

test('POST /api/start: rules未指定なら基本ルールのみ、基本ファイル無しなら空', async (t) => {
  const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-rules-test2-'));
  const rulesPath = path.join(rulesDir, 'PARTICIPANT_RULES.md');
  fs.writeFileSync(rulesPath, 'ダミー基本のみ', 'utf8');
  const { baseUrl } = await startServerWithRulesPath(t, rulesPath);
  const res = await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 2 });
  assert.equal(res.status, 200);
  assert.equal(res.body.board.meta.rules, 'ダミー基本のみ');

  // 基本ファイルが存在しない場合（別サーバ）: rulesは空文字
  const missing = path.join(rulesDir, 'no-such-rules.md');
  const { baseUrl: baseUrl2 } = await startServerWithRulesPath(t, missing);
  const res2 = await postJson(`${baseUrl2}/api/start`, { topic: TOPIC, maxRounds: 2 });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.board.meta.rules, '');
});

test('POST /api/start: rulesが4000字超・非文字列は400、ちょうど4000字はOK', async (t) => {
  const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-rules-test3-'));
  const { baseUrl } = await startServerWithRulesPath(t, path.join(rulesDir, 'none.md'));

  const tooLong = 'あ'.repeat(4001);
  const res = await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 2, rules: tooLong });
  assert.equal(res.status, 400);

  const badType = await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 2, rules: 123 });
  assert.equal(badType.status, 400);

  const ok = await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 2, rules: 'あ'.repeat(4000) });
  assert.equal(ok.status, 200);
});

test('POST /api/start: rulesがフェイクアダプタのpromptTextに注入される', async (t) => {
  const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-rules-test4-'));
  const rulesPath = path.join(rulesDir, 'PARTICIPANT_RULES.md');
  fs.writeFileSync(rulesPath, 'ダミー基本ルールX', 'utf8');

  const stateDir = makeStateDir();
  // human無しの2AI構成（human待ちで議論が止まらないように）
  const config = {
    port: 0,
    maxRounds: 1,
    participants: [
      { id: 'a', name: 'A', adapter: 'claude', enabled: true },
      { id: 'b', name: 'B', adapter: 'codex', enabled: true },
    ],
  };
  const prompts = [];
  const spy = (label) => ({
    async speak(ctx) {
      prompts.push(ctx.promptText);
      return { utterance: `${label}発言`, cardOps: [], noteUpdate: null, pass: true, error: null };
    },
  });
  const server = createServer({ config, adapters: { a: spy('A'), b: spy('B') }, stateDir, rulesPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sseReqs = [];
  t.after(
    () =>
      new Promise((resolve) => {
        for (const req of sseReqs) {
          try {
            req.destroy();
          } catch {
            /* already closed */
          }
        }
        server.close(() => resolve());
      })
  );
  const sse = connectSSE(`${baseUrl}/api/events`, sseReqs);

  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 1, rules: '追加ルールY' });
  await waitFor(() => sse.events.some((e) => e.type === 'ended'));

  assert.ok(prompts.length > 0);
  for (const p of prompts) {
    assert.ok(p.includes('--- ルール（厳守） ---'));
    assert.ok(p.includes('ダミー基本ルールX'));
    assert.ok(p.includes('追加ルールY'));
  }
});

test('サーバは静的にpublic/index.htmlを配信する', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const text = await res.text();
  assert.match(text, /<title>debate-board<\/title>/);
});
