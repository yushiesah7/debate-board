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

test('サーバは静的にpublic/index.htmlを配信する', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const text = await res.text();
  assert.match(text, /<title>debate-board<\/title>/);
});
