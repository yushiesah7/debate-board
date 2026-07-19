/**
 * test/engine.test.mjs — node:test によるengine/state純ロジックの検証。
 * ダミーお題「きのこ vs たけのこ」のみ使用（実議論内容は書かない）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createDebate, loadDebate } from '../src/state.mjs';
import { runDebate } from '../src/engine.mjs';

const TOPIC = 'きのこ vs たけのこ';

/** テストごとに独立した一時 state ディレクトリを作る */
function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'debate-board-test-'));
}

function baseConfig(overrides = {}) {
  return {
    maxRounds: 4,
    participants: [
      { id: 'a', name: 'A', adapter: 'claude', enabled: true },
      { id: 'b', name: 'B', adapter: 'codex', enabled: true },
    ],
    ...overrides,
  };
}

/** 常に発言してpassしないフェイクアダプタ */
function alwaysSpeakAdapter(label) {
  return {
    async speak(ctx) {
      return {
        utterance: `${label}のR${ctx.round}発言`,
        cardOps: [],
        pass: false,
      };
    },
  };
}

test('4ラウンド完走する', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig());
  const adapters = {
    a: alwaysSpeakAdapter('A'),
    b: alwaysSpeakAdapter('B'),
  };

  const result = await runDebate({ stateDir, board, adapters });

  assert.equal(result.meta.round, 4);
  assert.equal(result.meta.status, 'ended');

  const saved = loadDebate(stateDir, board.meta.id);
  assert.equal(saved.meta.round, 4);

  const lines = fs
    .readFileSync(path.join(stateDir, board.meta.id, 'transcript.jsonl'), 'utf8')
    .trim()
    .split('\n');
  // 4ラウンド x 2参加者 = 8ターン
  assert.equal(lines.length, 8);
});

test('cardOps（add/move/edit）が適用される', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig({ maxRounds: 1 }));

  let turnNo = 0;
  const adapters = {
    a: {
      async speak(ctx) {
        turnNo += 1;
        if (turnNo === 1) {
          return {
            utterance: 'カードを追加します',
            cardOps: [{ op: 'add', lane: 'discussing', title: '論点1', body: '本文1' }],
            pass: false,
          };
        }
        return { utterance: '続けます', cardOps: [], pass: true };
      },
    },
    b: {
      // engineはctxに生のboardを渡さない設計（boardSummaryという文字列要約のみ）。
      // このフェイクではテスト用にクロージャで捕まえたboard自体を直接参照する
      // （実アダプタはctx.boardSummary/ctx.promptだけを使う想定）。
      async speak() {
        const card = board.cards[0];
        if (!card) return { utterance: '', cardOps: [], pass: true };
        return {
          utterance: 'カードを移動して編集します',
          cardOps: [
            { op: 'move', cardId: card.id, lane: 'decided' },
            { op: 'edit', cardId: card.id, title: '論点1（決定）', body: '編集後の本文' },
          ],
          pass: false,
        };
      },
    },
  };

  await runDebate({ stateDir, board, adapters });

  assert.equal(board.cards.length, 1);
  const card = board.cards[0];
  assert.equal(card.lane, 'decided');
  assert.equal(card.title, '論点1（決定）');
  assert.equal(card.body, '編集後の本文');
});

test('不正なcardOpsは無視されwarningsに残る', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig({ maxRounds: 1 }));

  const adapters = {
    a: {
      async speak() {
        return {
          utterance: '不正な操作をします',
          cardOps: [
            { op: 'move', cardId: 'no-such-card', lane: 'decided' },
            { op: 'add', lane: 'invalid-lane', title: 'x' },
          ],
          pass: true,
        };
      },
    },
    b: {
      async speak() {
        return { utterance: '', cardOps: [], pass: true };
      },
    },
  };

  await runDebate({ stateDir, board, adapters });

  assert.equal(board.cards.length, 0);

  const lines = fs
    .readFileSync(path.join(stateDir, board.meta.id, 'transcript.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const aEntry = lines.find((e) => e.participantId === 'a');
  assert.ok(aEntry.warnings.length >= 2);
});

test('ONの全AIが同一ラウンドでpassすると早期終了する', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig({ maxRounds: 4 }));

  const adapters = {
    a: { async speak() { return { utterance: '', cardOps: [], pass: true }; } },
    b: { async speak() { return { utterance: '', cardOps: [], pass: true }; } },
  };

  await runDebate({ stateDir, board, adapters });

  assert.equal(board.meta.round, 1);
});

test('speakがrejectしたらpass扱いで続行する', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig({ maxRounds: 1 }));

  const adapters = {
    a: {
      async speak() {
        throw new Error('アダプタが例外を投げた');
      },
    },
    b: {
      async speak() {
        return { utterance: '続行できています', cardOps: [], pass: false };
      },
    },
  };

  const result = await runDebate({ stateDir, board, adapters });

  // エンジンが停止せず最後まで進み、synthesisも実行されている
  assert.equal(result.meta.status, 'ended');
  const lines = fs
    .readFileSync(path.join(stateDir, board.meta.id, 'transcript.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const aEntry = lines.find((e) => e.participantId === 'a');
  assert.equal(aEntry.pass, true);
  assert.ok(aEntry.error);
});

test('シンセシスの結果がboard.summaryに入る', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig({ maxRounds: 1 }));

  const adapters = {
    a: {
      async speak(ctx) {
        if (ctx.transcriptTail !== undefined) {
          // synthesisターン
          return { summary: 'まとめ: 結論が出ました' };
        }
        return { utterance: '発言A', cardOps: [], pass: true };
      },
    },
    b: {
      async speak() {
        return { utterance: '発言B', cardOps: [], pass: true };
      },
    },
  };

  const result = await runDebate({ stateDir, board, adapters });

  assert.equal(result.summary, 'まとめ: 結論が出ました');
  const saved = loadDebate(stateDir, board.meta.id);
  assert.equal(saved.summary, 'まとめ: 結論が出ました');
});
