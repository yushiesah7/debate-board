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

test('POST /api/start: rules指定でdefaultSnapshot＋common（3層形式）がstateに反映される', async (t) => {
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
  // GUI契約は {default, common, byId}
  assert.ok(rules.default.includes('ダミー基本ルール1'));
  assert.equal(rules.common, '今回だけのダミー追加ルール');
  assert.deepEqual(rules.byId, {});

  // GET /api/state でも同じrulesが返る
  const state = await getJson(`${baseUrl}/api/state`);
  assert.deepEqual(state.body.board.meta.rules, rules);
});

test('POST /api/start: rules未指定ならdefaultのみ、基本ファイル無しなら全て空', async (t) => {
  const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-rules-test2-'));
  const rulesPath = path.join(rulesDir, 'PARTICIPANT_RULES.md');
  fs.writeFileSync(rulesPath, 'ダミー基本のみ', 'utf8');
  const { baseUrl } = await startServerWithRulesPath(t, rulesPath);
  const res = await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 2 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.board.meta.rules, { default: 'ダミー基本のみ', common: '', byId: {} });

  // 基本ファイルが存在しない場合（別サーバ）: 全て空
  const missing = path.join(rulesDir, 'no-such-rules.md');
  const { baseUrl: baseUrl2 } = await startServerWithRulesPath(t, missing);
  const res2 = await postJson(`${baseUrl2}/api/start`, { topic: TOPIC, maxRounds: 2 });
  assert.equal(res2.status, 200);
  assert.deepEqual(res2.body.board.meta.rules, { default: '', common: '', byId: {} });
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

// --------------------------------------------------------------------
// GET /api/rules（デフォルトルールの閲覧専用）
// --------------------------------------------------------------------

test('GET /api/rules: {default}でファイル内容が返る／ファイル無しは""／POSTは405', async (t) => {
  const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-rules-api-'));
  const rulesPath = path.join(rulesDir, 'PARTICIPANT_RULES.md');
  fs.writeFileSync(rulesPath, 'ダミーデフォルトルール本文', 'utf8');
  const { baseUrl } = await startServerWithRulesPath(t, rulesPath);
  const res = await getJson(`${baseUrl}/api/rules`);
  assert.equal(res.status, 200);
  assert.equal(res.body.default, 'ダミーデフォルトルール本文');

  // 編集APIは廃止（デフォルトルールはGUIから編集不可）
  const post = await postJson(`${baseUrl}/api/rules`, { default: 'x' });
  assert.equal(post.status, 405);

  // ファイル無しのサーバ: defaultは""
  const { baseUrl: baseUrl2 } = await startServerWithRulesPath(t, path.join(rulesDir, 'no-such.md'));
  const res2 = await getJson(`${baseUrl2}/api/rules`);
  assert.equal(res2.status, 200);
  assert.equal(res2.body.default, '');
});

// --------------------------------------------------------------------
// POST /api/session-rules（その場の共通/個別ルール）
// --------------------------------------------------------------------

test('POST /api/session-rules: idle時はステージングされstartでboardに反映される', async (t) => {
  const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-session-rules-'));
  const rulesPath = path.join(rulesDir, 'PARTICIPANT_RULES.md');
  fs.writeFileSync(rulesPath, 'ダミーデフォルト', 'utf8');
  const { baseUrl } = await startServerWithRulesPath(t, rulesPath);

  // idle時に共通＋個別をステージング
  const staged = await postJson(`${baseUrl}/api/session-rules`, {
    common: 'ダミー共通ルール',
    byId: { a: 'Aだけのダミールール' },
  });
  assert.equal(staged.status, 200);
  assert.deepEqual(staged.body.board.meta.rules, {
    default: 'ダミーデフォルト',
    common: 'ダミー共通ルール',
    byId: { a: 'Aだけのダミールール' },
  });

  // start: defaultSnapshot＋ステージング＋開始モーダル追加ルール（commonへ追記結合）
  const start = await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 2, rules: '開始時の追記' });
  assert.equal(start.status, 200);
  const rules = start.body.board.meta.rules;
  assert.equal(rules.default, 'ダミーデフォルト');
  assert.equal(rules.common, 'ダミー共通ルール\n開始時の追記');
  assert.deepEqual(rules.byId, { a: 'Aだけのダミールール' });
});

test('POST /api/session-rules: 実行中はboardをmutateし次ターンのプロンプトに個別ルールが入る', async (t) => {
  const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-session-rules2-'));
  const rulesPath = path.join(rulesDir, 'PARTICIPANT_RULES.md');
  fs.writeFileSync(rulesPath, 'ダミーデフォルトZ', 'utf8');

  const stateDir = makeStateDir();
  const config = {
    port: 0,
    maxRounds: 3,
    participants: [
      { id: 'a', name: 'A', adapter: 'claude', enabled: true },
      { id: 'b', name: 'B', adapter: 'codex', enabled: true },
      { id: 'you', name: 'あなた', adapter: 'human', enabled: true },
    ],
  };
  const promptsA = [];
  const promptsB = [];
  const spy = (label, sink) => ({
    async speak(ctx) {
      sink.push(ctx.promptText);
      return { utterance: `${label}発言R${ctx.round ?? '-'}`, cardOps: [], noteUpdate: null, pass: false, error: null };
    },
  });
  const server = createServer({
    config,
    adapters: { a: spy('A', promptsA), b: spy('B', promptsB) },
    stateDir,
    rulesPath,
  });
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

  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 3 });
  await waitFor(() => sse.events.some((e) => e.type === 'await-human')); // R1のa/bは発言済み

  // R1のプロンプトには個別ルールが無い
  assert.ok(!promptsA[0].includes('あなたの個別ルール'));

  // 実行中に共通＋Aの個別ルールを設定
  const patch = await postJson(`${baseUrl}/api/session-rules`, {
    common: '実行中に足したダミー共通',
    byId: { a: 'Aへの実行中ダミー個別' },
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.board.meta.rules.common, '実行中に足したダミー共通');

  await postJson(`${baseUrl}/api/skip`, {}); // R2へ
  await waitFor(() => promptsA.length >= 2 && promptsB.length >= 2);

  // R2のAのプロンプト: default＋共通＋自分の個別
  assert.ok(promptsA[1].includes('ダミーデフォルトZ'));
  assert.ok(promptsA[1].includes('## この議論の共通ルール\n実行中に足したダミー共通'));
  assert.ok(promptsA[1].includes('## あなたの個別ルール\nAへの実行中ダミー個別'));
  // Bのプロンプトには共通は入るがAの個別は入らない
  assert.ok(promptsB[1].includes('実行中に足したダミー共通'));
  assert.ok(!promptsB[1].includes('Aへの実行中ダミー個別'));
});

test('POST /api/session-rules: ""でエントリ削除・上限/不正pid/非stringは400', async (t) => {
  const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-session-rules3-'));
  const { baseUrl } = await startServerWithRulesPath(t, path.join(rulesDir, 'none.md'));

  await postJson(`${baseUrl}/api/session-rules`, { byId: { a: 'ダミー個別', b: 'Bのダミー' } });
  // ""でaのエントリ削除
  const del = await postJson(`${baseUrl}/api/session-rules`, { byId: { a: '' } });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.board.meta.rules.byId, { b: 'Bのダミー' });

  // バリデーション
  const badPid = await postJson(`${baseUrl}/api/session-rules`, { byId: { nope: 'x' } });
  assert.equal(badPid.status, 400);
  const badType = await postJson(`${baseUrl}/api/session-rules`, { common: 123 });
  assert.equal(badType.status, 400);
  const badEntry = await postJson(`${baseUrl}/api/session-rules`, { byId: { a: 42 } });
  assert.equal(badEntry.status, 400);
  const tooLongCommon = await postJson(`${baseUrl}/api/session-rules`, { common: 'あ'.repeat(4001) });
  assert.equal(tooLongCommon.status, 400);
  const tooLongEntry = await postJson(`${baseUrl}/api/session-rules`, { byId: { a: 'あ'.repeat(4001) } });
  assert.equal(tooLongEntry.status, 400);
  const empty = await postJson(`${baseUrl}/api/session-rules`, {});
  assert.equal(empty.status, 400);

  // 400のときは一切適用されていない
  const after = await getJson(`${baseUrl}/api/state`);
  assert.deepEqual(after.body.board.meta.rules.byId, { b: 'Bのダミー' });
});

// --------------------------------------------------------------------
// POST /api/import-notes（notes.jsonの取り込み）
// --------------------------------------------------------------------

test('POST /api/import-notes: 議論が無ければ409', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const res = await postJson(`${baseUrl}/api/import-notes`, { notes: { a: 'x' } });
  assert.equal(res.status, 409);
});

test('POST /api/import-notes: notesは既知pidのみマージ・cardsは新規採番で追加・summaryは無視', async (t) => {
  const { baseUrl, connectSSE: connect } = await startTestServer(t);
  const sse = connect('/api/events');
  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 5 });
  await waitFor(() => sse.events.some((e) => e.type === 'await-human'));

  const res = await postJson(`${baseUrl}/api/import-notes`, {
    notes: { a: '取り込んだAのメモ', nope: '未知pidはスキップ' },
    cards: [
      { lane: 'held', title: '取り込みカード1', body: 'ダミー本文' },
      { lane: 'bad-lane', title: '不正laneは無視される', body: '' },
    ],
    summary: '取り込みsummaryは無視されるべき',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.board.notes.a, '取り込んだAのメモ');
  assert.ok(!('nope' in res.body.board.notes));

  const imported = res.body.board.cards.find((c) => c.title === '取り込みカード1');
  assert.ok(imported, '取り込みカードが追加されていること');
  assert.equal(imported.createdBy, 'import');
  assert.match(imported.id, /^c\d+$/); // 新規ID採番
  assert.ok(!res.body.board.cards.some((c) => c.title === '不正laneは無視される'));
  assert.notEqual(res.body.board.summary, '取り込みsummaryは無視されるべき');
});

// --------------------------------------------------------------------
// /api/card のUX修正（idle 400維持・warnings応答）
// --------------------------------------------------------------------

test('POST /api/card: 議論未開始（idle）は400のまま', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const res = await postJson(`${baseUrl}/api/card`, { op: 'add', lane: 'held', title: 'ダミー', body: '' });
  assert.equal(res.status, 400);
});

test('POST /api/card: 不正opは200＋warnings付き応答（黙って捨てない）、正常opにはwarningsが付かない', async (t) => {
  const { baseUrl, connectSSE: connect } = await startTestServer(t);
  const sse = connect('/api/events');
  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 5 });
  await waitFor(() => sse.events.some((e) => e.type === 'await-human'));

  // title欠落のadd → 適用されずwarningsで返る
  const bad = await postJson(`${baseUrl}/api/card`, { op: 'add', lane: 'held' });
  assert.equal(bad.status, 200);
  assert.ok(Array.isArray(bad.body.warnings) && bad.body.warnings.length > 0);
  assert.ok(!bad.body.board.cards.some((c) => c.lane === 'held' && !c.title));

  // 存在しないcardIdのmove → warnings
  const badMove = await postJson(`${baseUrl}/api/card`, { op: 'move', cardId: 'c999', lane: 'held' });
  assert.equal(badMove.status, 200);
  assert.ok(Array.isArray(badMove.body.warnings) && badMove.body.warnings.length > 0);

  // 正常なadd → warningsフィールドなし
  const ok = await postJson(`${baseUrl}/api/card`, { op: 'add', lane: 'held', title: '正常カード', body: '' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.warnings, undefined);
  assert.ok(ok.body.board.cards.some((c) => c.title === '正常カード'));
});

// --------------------------------------------------------------------
// speaking（発言中インジケータ）
// --------------------------------------------------------------------

test('/api/state の speaking がターン中に設定され、ended後は null になる', async (t) => {
  const stateDir = makeStateDir();
  // human無しの2AI構成。aのspeakに遅延を入れて「考え中」の途中stateを覗く
  const config = {
    port: 0,
    maxRounds: 1,
    participants: [
      { id: 'a', name: 'A', adapter: 'claude', enabled: true },
      { id: 'b', name: 'B', adapter: 'codex', enabled: true },
    ],
  };
  const slowSpeaker = (label, delayMs) => ({
    async speak(ctx) {
      await new Promise((r) => setTimeout(r, delayMs));
      return { utterance: `${label}発言`, cardOps: [], noteUpdate: null, pass: true, error: null };
    },
  });
  const server = createServer({
    config,
    adapters: { a: slowSpeaker('A', 300), b: slowSpeaker('B', 50) },
    stateDir,
  });
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

  // 開始前はnull
  const idle = await getJson(`${baseUrl}/api/state`);
  assert.equal(idle.body.speaking, null);

  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 1 });

  // aのspeak中（300ms遅延）に覗く: SSEでturn-startが届いてから/api/stateを取得
  await waitFor(() => sse.events.some((e) => e.type === 'turn-start' && e.participantId === 'a'));
  const during = await getJson(`${baseUrl}/api/state`);
  assert.ok(during.body.speaking, 'ターン中はspeakingが設定されていること');
  assert.equal(during.body.speaking.participantId, 'a');
  assert.equal(during.body.speaking.phase, 'turn');
  assert.equal(during.body.speaking.round, 1);
  assert.equal(typeof during.body.speaking.since, 'string');

  // シンセシス開始イベントも流れる
  await waitFor(() => sse.events.some((e) => e.type === 'synthesis-start'));

  // 終了後はnull
  await waitFor(() => sse.events.some((e) => e.type === 'ended'));
  const after = await getJson(`${baseUrl}/api/state`);
  assert.equal(after.body.board.meta.status, 'ended');
  assert.equal(after.body.speaking, null);
});

test('speaking-progress: フェイクアダプタのctx.onProgress断片がSSEでまとめて届く', async (t) => {
  const stateDir = makeStateDir();
  const config = {
    port: 0,
    maxRounds: 1,
    participants: [
      { id: 'a', name: 'A', adapter: 'claude', enabled: true },
      { id: 'b', name: 'B', adapter: 'codex', enabled: true },
    ],
  };
  const progressSpeaker = (label) => ({
    async speak(ctx) {
      if (typeof ctx.onProgress === 'function') {
        ctx.onProgress(`${label}の断片1`);
        ctx.onProgress(`${label}の断片2`);
        await new Promise((r) => setTimeout(r, 150)); // スロットル(100ms)を跨がせてflushさせる
        ctx.onProgress(`${label}の断片3`);
      }
      return { utterance: `${label}発言`, cardOps: [], noteUpdate: null, pass: true, error: null };
    },
  });
  const server = createServer({
    config,
    adapters: { a: progressSpeaker('A'), b: progressSpeaker('B') },
    stateDir,
  });
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

  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 1 });
  await waitFor(() => sse.events.some((e) => e.type === 'ended'));

  const progressEvents = sse.events.filter((e) => e.type === 'speaking-progress');
  assert.ok(progressEvents.length > 0, 'speaking-progressイベントが届くこと');
  // Aの断片: スロットルにより1+2はまとめて1通、3は別便（少なくとも全文が揃う）
  const aText = progressEvents.filter((e) => e.participantId === 'a').map((e) => e.text).join('');
  assert.ok(aText.includes('Aの断片1Aの断片2'));
  assert.ok(aText.includes('Aの断片3'));
  const bText = progressEvents.filter((e) => e.participantId === 'b').map((e) => e.text).join('');
  assert.ok(bText.includes('Bの断片1'));
  // participantIdが必ず付いている
  assert.ok(progressEvents.every((e) => typeof e.participantId === 'string'));
});

// --------------------------------------------------------------------
// POST /api/extend（ラウンド延長＋終了後の再開）
// --------------------------------------------------------------------

/** human無しの2AIサーバを起動する共通ヘルパー（extend/inheritテスト用） */
async function startTwoAiServer(t, { maxRounds = 1, adapters, rulesPath, autoExportDir } = {}) {
  const stateDir = makeStateDir();
  const config = {
    port: 0,
    maxRounds,
    participants: [
      { id: 'a', name: 'A', adapter: 'claude', enabled: true },
      { id: 'b', name: 'B', adapter: 'codex', enabled: true },
    ],
    // autoExportDir未指定のテストでは自動エクスポート無効（リポのexports/を汚さない）
    ...(autoExportDir ? { autoExportDir } : {}),
  };
  const server = createServer({
    config,
    adapters: adapters ?? { a: fakeSpeaker('A'), b: fakeSpeaker('B') },
    stateDir,
    ...(rulesPath ? { rulesPath } : {}),
  });
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
  return { baseUrl, stateDir, connectSSE: (p) => connectSSE(`${baseUrl}${p}`, sseReqs) };
}

test('POST /api/extend: 実行中はmaxRoundsが加算される', async (t) => {
  const { baseUrl, connectSSE: connect } = await startTestServer(t);
  const sse = connect('/api/events');
  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 3 });
  await waitFor(() => sse.events.some((e) => e.type === 'await-human')); // humanターンで停止中

  const res = await postJson(`${baseUrl}/api/extend`, { rounds: 2 });
  assert.equal(res.status, 200);
  assert.equal(res.body.board.meta.maxRounds, 5);
  assert.equal(res.body.board.meta.status, 'running'); // 実行中のまま
});

test('POST /api/extend: 終了後は延長して再開し、続きのラウンドが走ってsummaryが再生成される', async (t) => {
  let synthCount = 0;
  const roundsSeen = [];
  const speaker = (label) => ({
    async speak(ctx) {
      if (ctx.round !== undefined) {
        roundsSeen.push(`${label}${ctx.round}`);
        return { utterance: `${label}のR${ctx.round}`, cardOps: [], noteUpdate: null, pass: false, error: null };
      }
      synthCount += 1; // シンセシスターン
      return { utterance: `まとめ${synthCount}回目`, cardOps: [], noteUpdate: null, pass: false, error: null };
    },
  });
  const { baseUrl, connectSSE: connect } = await startTwoAiServer(t, {
    maxRounds: 1,
    adapters: { a: speaker('A'), b: speaker('B') },
  });
  const sse = connect('/api/events');

  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 1 });
  await waitFor(() => sse.events.some((e) => e.type === 'ended'));
  const first = await getJson(`${baseUrl}/api/state`);
  assert.equal(first.body.board.meta.endedBy, 'maxRounds');
  assert.equal(first.body.board.summary, 'まとめ1回目');

  // 延長して再開 → 2ラウンド目が走り、summaryが上書きされる
  const ext = await postJson(`${baseUrl}/api/extend`, { rounds: 1 });
  assert.equal(ext.status, 200);
  assert.equal(ext.body.board.meta.maxRounds, 2);
  assert.equal(ext.body.board.meta.status, 'running');
  assert.equal(ext.body.board.meta.endedBy, null);

  await waitFor(() => sse.events.filter((e) => e.type === 'ended').length >= 2);
  const second = await getJson(`${baseUrl}/api/state`);
  assert.equal(second.body.board.meta.round, 2);
  assert.equal(second.body.board.meta.status, 'ended');
  assert.equal(second.body.board.summary, 'まとめ2回目'); // 再終了時に上書き
  assert.ok(roundsSeen.includes('A2') && roundsSeen.includes('B2')); // 続きのラウンドが実走
});

test('POST /api/extend: idleは400・範囲外/非整数は400', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const idle = await postJson(`${baseUrl}/api/extend`, { rounds: 1 });
  assert.equal(idle.status, 400); // 議論なし

  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 3 });
  for (const bad of [0, 21, 1.5, '2', null, undefined]) {
    const res = await postJson(`${baseUrl}/api/extend`, { rounds: bad });
    assert.equal(res.status, 400, `rounds=${JSON.stringify(bad)} は400のはず`);
  }
});

// --------------------------------------------------------------------
// POST /api/start の inherit（前回の議論からの引き継ぎ）
// --------------------------------------------------------------------

test('POST /api/start inherit: cards+notes+summaryCardが新boardへseedされる', async (t) => {
  // 1議論目: カード追加＋NOTE更新＋summary生成して終了させる
  const speaker = (label, { withCardAndNote = false } = {}) => {
    let turn = 0;
    return {
      async speak(ctx) {
        if (ctx.round === undefined) {
          return { utterance: 'ダミーまとめ', cardOps: [], noteUpdate: null, pass: false, error: null };
        }
        turn += 1;
        return {
          utterance: `${label}のR${ctx.round}`,
          cardOps:
            withCardAndNote && turn === 1
              ? [{ op: 'add', cardId: null, lane: 'discussing', title: '引き継ぎ元カード', body: 'ダミー本文' }]
              : [],
          noteUpdate: withCardAndNote && turn === 1 ? '引き継ぎ元のAメモ' : null,
          pass: true,
          error: null,
        };
      },
    };
  };
  const { baseUrl, connectSSE: connect } = await startTwoAiServer(t, {
    maxRounds: 1,
    adapters: { a: speaker('A', { withCardAndNote: true }), b: speaker('B') },
  });
  const sse = connect('/api/events');
  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 1 });
  await waitFor(() => sse.events.some((e) => e.type === 'ended'));

  // 2議論目: cards+notes+summaryCardを引き継いで開始
  const res = await postJson(`${baseUrl}/api/start`, {
    topic: `${TOPIC} 第2戦`,
    maxRounds: 1,
    inherit: { cards: true, notes: true, summaryCard: true },
  });
  assert.equal(res.status, 200);
  const board = res.body.board;
  const inheritedCard = board.cards.find((c) => c.title === '引き継ぎ元カード');
  assert.ok(inheritedCard, '前回カードがコピーされていること');
  assert.equal(inheritedCard.lane, 'discussing');
  assert.equal(inheritedCard.createdBy, 'a'); // createdBy維持
  assert.equal(board.notes.a, '引き継ぎ元のAメモ');
  const summaryCard = board.cards.find((c) => c.title === `📋 前回の結論（${TOPIC}）`);
  assert.ok(summaryCard, '前回summaryのカード化');
  assert.equal(summaryCard.lane, 'decided');
  assert.equal(summaryCard.createdBy, 'inherit');
  assert.equal(summaryCard.body, 'ダミーまとめ');
  // 新ID採番でIDが重複していない
  const ids = board.cards.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('POST /api/start inherit: rulesは前回boardのcommon/byIdがステージングより優先される', async (t) => {
  const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-inherit-rules-'));
  const rulesPath = path.join(rulesDir, 'PARTICIPANT_RULES.md');
  fs.writeFileSync(rulesPath, 'ダミーデフォルトR', 'utf8');
  const { baseUrl, connectSSE: connect } = await startTwoAiServer(t, { maxRounds: 1, rulesPath });
  const sse = connect('/api/events');

  // 1議論目をステージング済みルールで開始→終了
  await postJson(`${baseUrl}/api/session-rules`, { common: '前回の共通', byId: { a: '前回のA個別' } });
  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 1 });
  await waitFor(() => sse.events.some((e) => e.type === 'ended'));

  // 終了後にステージングを書き換える（inherit.rulesならこれは使われない）
  await postJson(`${baseUrl}/api/session-rules`, { common: '新しいステージング共通', byId: { b: '新B個別' } });

  const res = await postJson(`${baseUrl}/api/start`, {
    topic: `${TOPIC} 第2戦`,
    maxRounds: 1,
    inherit: { rules: true },
  });
  assert.equal(res.status, 200);
  const rules = res.body.board.meta.rules;
  assert.equal(rules.default, 'ダミーデフォルトR'); // defaultSnapshotは新規読込
  assert.equal(rules.common, '前回の共通'); // ステージングではなく前回board優先
  assert.deepEqual(rules.byId, { a: '前回のA個別' });
});

test('POST /api/start inherit: 前回boardが無ければ無視される', async (t) => {
  const { baseUrl } = await startTwoAiServer(t, { maxRounds: 1 });
  const res = await postJson(`${baseUrl}/api/start`, {
    topic: TOPIC,
    maxRounds: 1,
    inherit: { cards: true, notes: true, rules: true, summaryCard: true },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.board.cards.length, 0); // 何もseedされない
});

// --------------------------------------------------------------------
// 議論終了時の自動エクスポート
// --------------------------------------------------------------------

test('自動エクスポート: ended時にrules/notesの2ファイルが書き出されSSEでauto-exportが届く', async (t) => {
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-export-'));
  const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-export-rules-'));
  const rulesPath = path.join(rulesDir, 'PARTICIPANT_RULES.md');
  fs.writeFileSync(rulesPath, 'エクスポート用ダミーデフォルト', 'utf8');

  const speaker = (label) => ({
    async speak(ctx) {
      if (ctx.round === undefined) {
        return { utterance: 'エクスポート用まとめ', cardOps: [], noteUpdate: null, pass: false, error: null };
      }
      return {
        utterance: `${label}のR${ctx.round}`,
        cardOps: label === 'A' ? [{ op: 'add', cardId: null, lane: 'decided', title: 'エクスポート用カード', body: 'ダミー' }] : [],
        noteUpdate: label === 'A' ? 'エクスポート用Aメモ' : null,
        pass: true,
        error: null,
      };
    },
  });
  const { baseUrl, connectSSE: connect } = await startTwoAiServer(t, {
    maxRounds: 1,
    adapters: { a: speaker('A'), b: speaker('B') },
    rulesPath,
    autoExportDir: exportDir,
  });
  const sse = connect('/api/events');

  await postJson(`${baseUrl}/api/session-rules`, { common: 'エクスポート用共通', byId: { a: 'エクスポート用A個別' } });
  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 1 });
  await waitFor(() => sse.events.some((e) => e.type === 'ended'));

  // SSEのauto-exportイベント
  await waitFor(() => sse.events.some((e) => e.type === 'auto-export'));
  const evt = sse.events.find((e) => e.type === 'auto-export');
  assert.ok(Array.isArray(evt.files) && evt.files.length === 2);

  // 実ファイル2件（-rules.json / -notes.json）
  const written = fs.readdirSync(exportDir).sort();
  assert.equal(written.length, 2);
  const rulesFile = written.find((f) => f.endsWith('-rules.json'));
  const notesFile = written.find((f) => f.endsWith('-notes.json'));
  assert.ok(rulesFile && notesFile);
  // 同一prefix・タイムスタンプ+スラッグ形式
  assert.equal(rulesFile.replace(/-rules\.json$/, ''), notesFile.replace(/-notes\.json$/, ''));
  assert.match(rulesFile, /^\d{8}-\d{6}_.+-rules\.json$/);

  // 形式: 既存のrules.json / notes.jsonエクスポートと同形
  const rulesJson = JSON.parse(fs.readFileSync(path.join(exportDir, rulesFile), 'utf8'));
  assert.equal(rulesJson.type, 'debate-board-rules');
  assert.equal(rulesJson.version, 1);
  assert.equal(rulesJson.common, 'エクスポート用共通');
  assert.deepEqual(rulesJson.participants, { a: 'エクスポート用A個別' });

  const notesJson = JSON.parse(fs.readFileSync(path.join(exportDir, notesFile), 'utf8'));
  assert.equal(notesJson.type, 'debate-board-notes');
  assert.equal(notesJson.version, 1);
  assert.equal(notesJson.notes.a, 'エクスポート用Aメモ');
  assert.equal(notesJson.summary, 'エクスポート用まとめ');
  assert.ok(notesJson.cards.some((c) => c.title === 'エクスポート用カード' && c.lane === 'decided'));
  assert.ok(!('id' in (notesJson.cards[0] ?? {})), 'cardsはid抜きの持ち運び形式');
});

// --------------------------------------------------------------------
// POST /api/interject（特定参加者への割り込み依頼）
// --------------------------------------------------------------------

test('POST /api/interject: 実行中はpaused経由でrunning復帰し、transcriptに2エントリ＋cardOps適用', async (t) => {
  // humanターン（エンジン停止中・入力バーと両立）で割り込む
  const { baseUrl, connectSSE: connect } = await startTestServer(t);
  const sse = connect('/api/events');
  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 5 });
  await waitFor(() => sse.events.some((e) => e.type === 'await-human')); // human入力待ち=割り込み可

  const res = await postJson(`${baseUrl}/api/interject`, { participantId: 'a', text: '追加観点をひとつ' });
  assert.equal(res.status, 200);
  assert.equal(res.body.board.meta.status, 'running'); // pausedから復帰済み

  const transcript = res.body.transcript;
  const reqEntry = transcript.find((e) => e.interject === 'request');
  const replyEntry = transcript.find((e) => e.interject === 'reply');
  assert.ok(reqEntry, 'requestエントリ');
  assert.equal(reqEntry.speaker, 'owner');
  assert.equal(reqEntry.targetId, 'a');
  assert.equal(reqEntry.text, '追加観点をひとつ');
  assert.ok(replyEntry, 'replyエントリ');
  assert.equal(replyEntry.speaker, 'A');
  assert.ok(replyEntry.text.length > 0);
});

test('POST /api/interject: ended後もendedのまま応答し、cardOps/noteUpdateが適用される', async (t) => {
  const a = {
    async speak(ctx) {
      if (ctx.interject) {
        return {
          utterance: '終了後のダミー応答',
          cardOps: [{ op: 'add', cardId: null, lane: 'held', title: '終了後の割り込みカード', body: '' }],
          noteUpdate: '終了後のNOTE',
          pass: false,
          error: null,
        };
      }
      if (ctx.round === undefined) {
        return { utterance: 'まとめ', cardOps: [], noteUpdate: null, pass: false, error: null };
      }
      return { utterance: `AのR${ctx.round}`, cardOps: [], noteUpdate: null, pass: true, error: null };
    },
  };
  const b = {
    async speak(ctx) {
      return { utterance: `BのR${ctx.round ?? '-'}`, cardOps: [], noteUpdate: null, pass: true, error: null };
    },
  };
  const { baseUrl, connectSSE: connect } = await startTwoAiServer(t, { maxRounds: 1, adapters: { a, b } });
  const sse = connect('/api/events');
  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 1 });
  await waitFor(() => sse.events.some((e) => e.type === 'ended'));

  const res = await postJson(`${baseUrl}/api/interject`, { participantId: 'a', text: '終了後の確認質問' });
  assert.equal(res.status, 200);
  assert.equal(res.body.board.meta.status, 'ended'); // endedのまま
  assert.ok(res.body.board.cards.some((c) => c.title === '終了後の割り込みカード'));
  assert.equal(res.body.board.notes.a, '終了後のNOTE');
  assert.ok(res.body.transcript.some((e) => e.interject === 'reply' && e.text === '終了後のダミー応答'));
});

test('POST /api/interject: AI発言中は409・human宛/不明pid/空テキスト/4000字超/議論なしは400', async (t) => {
  // 議論なし
  const { baseUrl: idleUrl } = await startTwoAiServer(t, { maxRounds: 1 });
  const idle = await postJson(`${idleUrl}/api/interject`, { participantId: 'a', text: 'x' });
  assert.equal(idle.status, 400);

  // AI発言中409: aのspeakを遅くして、その間に割り込む
  const slowA = {
    async speak(ctx) {
      if (ctx.interject) {
        return { utterance: '応答', cardOps: [], noteUpdate: null, pass: false, error: null };
      }
      await new Promise((r) => setTimeout(r, 400));
      return { utterance: `AのR${ctx.round ?? '-'}`, cardOps: [], noteUpdate: null, pass: true, error: null };
    },
  };
  const quickB = {
    async speak(ctx) {
      return { utterance: `BのR${ctx.round ?? '-'}`, cardOps: [], noteUpdate: null, pass: true, error: null };
    },
  };
  const { baseUrl } = await startTwoAiServer(t, {
    maxRounds: 1,
    adapters: { a: slowA, b: quickB },
  });
  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 1 });
  // aのspeak中（400ms窓）を/api/stateポーリングで捕まえて割り込む（SSE接続レース回避）
  let busy = null;
  {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const st = await getJson(`${baseUrl}/api/state`);
      if (st.body.speaking && st.body.speaking.participantId === 'a') {
        busy = await postJson(`${baseUrl}/api/interject`, { participantId: 'b', text: 'いま話せる？' });
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  assert.ok(busy, 'aの発言中を捕捉できること');
  assert.equal(busy.status, 409);

  // 議論終了を待つ（ポーリング）
  {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const st = await getJson(`${baseUrl}/api/state`);
      if (st.body.board.meta.status === 'ended') break;
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  // human宛・不明pid・空テキスト・超過
  const humanServer = await startTestServer(t);
  const humanSse = humanServer.connectSSE('/api/events'); // start前に接続（イベント取り逃し防止）
  await postJson(`${humanServer.baseUrl}/api/start`, { topic: TOPIC, maxRounds: 5 });
  await waitFor(() => humanSse.events.some((e) => e.type === 'await-human'));
  assert.equal((await postJson(`${humanServer.baseUrl}/api/interject`, { participantId: 'you', text: 'x' })).status, 400);
  assert.equal((await postJson(`${humanServer.baseUrl}/api/interject`, { participantId: 'nope', text: 'x' })).status, 400);
  assert.equal((await postJson(`${humanServer.baseUrl}/api/interject`, { participantId: 'a', text: '  ' })).status, 400);
  assert.equal((await postJson(`${humanServer.baseUrl}/api/interject`, { participantId: 'a', text: 'あ'.repeat(4001) })).status, 400);
});

// --------------------------------------------------------------------
// 議論履歴（GET /api/debates・GET /api/debates/<id>・POST /api/load・inherit.fromDebateId）
// --------------------------------------------------------------------

/** /api/state のstatusが指定値になるまでポーリング */
async function waitForStatus(baseUrl, status, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await getJson(`${baseUrl}/api/state`);
    if (st.body.board.meta.status === status) return st;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitForStatus: "${status}" にならないままタイムアウト`);
}

/** 履歴テスト用: カード＋NOTE＋summary付きで即終了するアダプタ */
function historySpeaker(label, { withCard = false } = {}) {
  return {
    async speak(ctx) {
      if (ctx.round === undefined) {
        return { utterance: `${label}のまとめ`, cardOps: [], noteUpdate: null, pass: false, error: null };
      }
      return {
        utterance: `${label}のR${ctx.round}`,
        cardOps: withCard && ctx.round === 1
          ? [{ op: 'add', cardId: null, lane: 'discussing', title: `${label}の履歴カード`, body: 'ダミー' }]
          : [],
        noteUpdate: withCard && ctx.round === 1 ? `${label}の履歴メモ` : null,
        pass: true,
        error: null,
      };
    },
  };
}

test('GET /api/debates: 複数議論が新しい順で並び、壊れたdirはスキップされる', async (t) => {
  const { baseUrl, stateDir } = await startTwoAiServer(t, {
    maxRounds: 1,
    adapters: { a: historySpeaker('A', { withCard: true }), b: historySpeaker('B') },
  });

  await postJson(`${baseUrl}/api/start`, { topic: `${TOPIC} 第1戦`, maxRounds: 1 });
  await waitForStatus(baseUrl, 'ended');
  await new Promise((r) => setTimeout(r, 30)); // mtime差を確実にする
  await postJson(`${baseUrl}/api/start`, { topic: `${TOPIC} 第2戦`, maxRounds: 1 });
  await waitForStatus(baseUrl, 'ended');

  // 壊れたdirを混入させる
  const brokenDir = path.join(stateDir, 'broken-debate');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, 'board.json'), '{not json', 'utf8');

  const res = await getJson(`${baseUrl}/api/debates`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 2); // 壊れたdirは含まれない
  assert.equal(res.body[0].topic, `${TOPIC} 第2戦`); // 新しい順
  assert.equal(res.body[1].topic, `${TOPIC} 第1戦`);
  const first = res.body[1];
  assert.equal(first.status, 'ended');
  assert.equal(first.endedBy, 'allPass');
  assert.equal(first.round, 1);
  assert.equal(first.maxRounds, 1);
  assert.equal(first.cardCount, 1);
  assert.equal(first.hasSummary, true);
  assert.equal(typeof first.updatedAt, 'string');
});

test('GET /api/debates/<id>: 詳細が返り、不明id・トラバーサルは404', async (t) => {
  const { baseUrl } = await startTwoAiServer(t, {
    maxRounds: 1,
    adapters: { a: historySpeaker('A', { withCard: true }), b: historySpeaker('B') },
  });
  await postJson(`${baseUrl}/api/start`, { topic: TOPIC, maxRounds: 1 });
  await waitForStatus(baseUrl, 'ended');

  const list = await getJson(`${baseUrl}/api/debates`);
  const id = list.body[0].id;
  const detail = await getJson(`${baseUrl}/api/debates/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.board.meta.topic, TOPIC);
  assert.ok(detail.body.board.meta.rules && typeof detail.body.board.meta.rules === 'object');
  assert.ok(detail.body.board.cards.some((c) => c.title === 'Aの履歴カード'));
  assert.equal(detail.body.board.notes.a, 'Aの履歴メモ');
  assert.equal(detail.body.board.summary, 'Aのまとめ');
  assert.ok(detail.body.transcript.some((e) => e.speaker === 'A' && e.text.includes('R1')));
  const pa = detail.body.participants.find((p) => p.id === 'a');
  assert.equal(pa.adapter, 'claude');
  assert.ok('model' in pa && 'effort' in pa && 'pcAccess' in pa);

  // 不明id・トラバーサル
  assert.equal((await getJson(`${baseUrl}/api/debates/no-such-id`)).status, 404);
  assert.equal((await getJson(`${baseUrl}/api/debates/%2e%2e`)).status, 404);
  assert.equal((await getJson(`${baseUrl}/api/debates/..%2F..%2Fconfig.json`)).status, 404);
});

test('POST /api/load: currentBoardを復元し、その後extendで再開できる／進行中・発言中は409', async (t) => {
  const { baseUrl } = await startTwoAiServer(t, {
    maxRounds: 1,
    adapters: { a: historySpeaker('A', { withCard: true }), b: historySpeaker('B') },
  });
  await postJson(`${baseUrl}/api/start`, { topic: `${TOPIC} 復元元`, maxRounds: 1 });
  await waitForStatus(baseUrl, 'ended');
  await new Promise((r) => setTimeout(r, 30));
  await postJson(`${baseUrl}/api/start`, { topic: `${TOPIC} 直近`, maxRounds: 1 });
  await waitForStatus(baseUrl, 'ended');

  const list = await getJson(`${baseUrl}/api/debates`);
  const oldId = list.body.find((d) => d.topic === `${TOPIC} 復元元`).id;

  // 不明idは400
  assert.equal((await postJson(`${baseUrl}/api/load`, { debateId: 'nope' })).status, 400);

  const loaded = await postJson(`${baseUrl}/api/load`, { debateId: oldId });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.board.meta.topic, `${TOPIC} 復元元`);
  assert.equal(loaded.body.board.meta.status, 'ended'); // 保存時statusのまま待機
  assert.ok(loaded.body.board.cards.some((c) => c.title === 'Aの履歴カード'));

  // 復元した議論を「延長して再開」→ 続きのラウンドが走って再終了する
  const ext = await postJson(`${baseUrl}/api/extend`, { rounds: 1 });
  assert.equal(ext.status, 200);
  assert.equal(ext.body.board.meta.status, 'running');
  await waitForStatus(baseUrl, 'ended');
  const after = await getJson(`${baseUrl}/api/state`);
  assert.equal(after.body.board.meta.round, 2);
  assert.equal(after.body.board.meta.topic, `${TOPIC} 復元元`);

  // 進行中の議論があるときのloadは409（再開直後を狙うのは不安定なので、遅いアダプタで別サーバ検証）
  const slow = {
    async speak(ctx) {
      if (ctx.round === undefined) return { utterance: 'まとめ', cardOps: [], pass: false };
      await new Promise((r) => setTimeout(r, 400));
      return { utterance: `R${ctx.round}`, cardOps: [], pass: true };
    },
  };
  const s2 = await startTwoAiServer(t, { maxRounds: 1, adapters: { a: slow, b: historySpeaker('B') } });
  await postJson(`${s2.baseUrl}/api/start`, { topic: TOPIC, maxRounds: 1 });
  // running中（speaking中含む）のload → 409（idはs2自身のstateDirに実在するものを使う）
  const s2Ids = fs.readdirSync(s2.stateDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.ok(s2Ids.length > 0);
  const busy = await postJson(`${s2.baseUrl}/api/load`, { debateId: s2Ids[0] });
  assert.equal(busy.status, 409);
});

test('POST /api/start inherit.fromDebateId: 指定した過去議論から引き継ぐ／不明idは400', async (t) => {
  const { baseUrl } = await startTwoAiServer(t, {
    maxRounds: 1,
    adapters: { a: historySpeaker('A', { withCard: true }), b: historySpeaker('B') },
  });
  await postJson(`${baseUrl}/api/start`, { topic: `${TOPIC} 引き継ぎ元`, maxRounds: 1 });
  await waitForStatus(baseUrl, 'ended');
  await new Promise((r) => setTimeout(r, 30));
  await postJson(`${baseUrl}/api/start`, { topic: `${TOPIC} 無関係な直近`, maxRounds: 1 });
  await waitForStatus(baseUrl, 'ended');

  const list = await getJson(`${baseUrl}/api/debates`);
  const srcId = list.body.find((d) => d.topic === `${TOPIC} 引き継ぎ元`).id;

  // 不明idは400
  const bad = await postJson(`${baseUrl}/api/start`, {
    topic: 'x',
    maxRounds: 1,
    inherit: { cards: true, fromDebateId: 'no-such' },
  });
  assert.equal(bad.status, 400);

  // fromDebateId指定: 直近（無関係な直近）ではなく指定元のカード・summaryカードを引き継ぐ
  const res = await postJson(`${baseUrl}/api/start`, {
    topic: `${TOPIC} 第3戦`,
    maxRounds: 1,
    inherit: { cards: true, summaryCard: true, fromDebateId: srcId },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.board.cards.some((c) => c.title === 'Aの履歴カード'));
  assert.ok(res.body.board.cards.some((c) => c.title === `📋 前回の結論（${TOPIC} 引き継ぎ元）`));
});

test('サーバは静的にpublic/index.htmlを配信する', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const text = await res.text();
  assert.match(text, /<title>debate-board<\/title>/);
});
