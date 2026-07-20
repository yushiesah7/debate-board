/**
 * test/engine.test.mjs — node:test によるengine/state純ロジックの検証。
 * ダミーお題「きのこ vs たけのこ」のみ使用（実議論内容は書かない）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createDebate, loadDebate, saveBoard, appendTranscript, loadTranscript, applyCardOps } from '../src/state.mjs';
import { runDebate } from '../src/engine.mjs';
import { TURN_SCHEMA, buildTurnPrompt, buildSynthesisPrompt, composeRulesFor } from '../src/prompt.mjs';

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
  assert.equal(result.meta.endedBy, 'maxRounds');

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
  assert.equal(board.meta.endedBy, 'allPass');
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

test('再開時にtranscriptからhistoryが復元される（未完ラウンドは頭からやり直し）', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig({ maxRounds: 2 }));

  // 前プロセスの実行結果を再現: ラウンド1完了＋ラウンド2の途中（aだけ発言）でクラッシュした体
  appendTranscript(stateDir, board.meta.id, {
    round: 1, participantId: 'a', utterance: '復元テスト発言A', pass: false, cardOps: [], warnings: [],
  });
  appendTranscript(stateDir, board.meta.id, {
    round: 1, participantId: 'b', utterance: '復元テスト発言B', pass: false, cardOps: [], warnings: [],
  });
  appendTranscript(stateDir, board.meta.id, {
    round: 2, participantId: 'a', utterance: 'クラッシュ前の中途発言', pass: false, cardOps: [], warnings: [],
  });
  board.meta.round = 1; // ラウンド1のみ完了扱い
  saveBoard(stateDir, board);

  const reloaded = loadDebate(stateDir, board.meta.id);
  const seen = [];
  const adapters = {
    a: {
      async speak(ctx) {
        if (ctx.round !== undefined) seen.push(ctx.recentTranscript);
        return { utterance: '再開後の発言', cardOps: [], pass: true };
      },
    },
    b: { async speak() { return { utterance: '', cardOps: [], pass: true }; } },
  };

  await runDebate({ stateDir, board: reloaded, adapters });

  // 再開はラウンド2から（未完ラウンドを頭からやり直す）
  assert.equal(seen.length, 1);
  const recent = seen[0];
  // ラウンド1の発言がファイルから復元されて文脈に入っている
  assert.ok(recent.some((e) => e.round === 1 && e.utterance === '復元テスト発言A'));
  // 未完ラウンド2の中途エントリは文脈に含まれない
  assert.ok(!recent.some((e) => e.utterance === 'クラッシュ前の中途発言'));
});

test('recentTranscriptは直近2ラウンドの窓（round-2以降）', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig({ maxRounds: 4 }));

  let round4Recent = null;
  const adapters = {
    a: {
      async speak(ctx) {
        if (ctx.round === 4) round4Recent = ctx.recentTranscript;
        return { utterance: `AのR${ctx.round}`, cardOps: [], pass: false };
      },
    },
    b: alwaysSpeakAdapter('B'),
  };

  await runDebate({ stateDir, board, adapters });

  assert.ok(round4Recent !== null);
  const rounds = round4Recent.map((e) => e.round);
  assert.ok(rounds.every((r) => r >= 2), `ラウンド1が混入: ${rounds}`);
  assert.ok(rounds.includes(2));
  assert.ok(rounds.includes(3));
});

test('status=endedのboardを渡すと即no-op return', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig());
  board.meta.status = 'ended';
  saveBoard(stateDir, board);

  let called = 0;
  const adapters = {
    a: { async speak() { called += 1; return { pass: true }; } },
    b: { async speak() { called += 1; return { pass: true }; } },
  };
  const events = [];

  const result = await runDebate({ stateDir, board, adapters, onEvent: (e) => events.push(e) });

  assert.equal(called, 0);
  assert.equal(events.length, 0);
  assert.equal(result.meta.status, 'ended');
});

test('onEventが例外を投げても進行が止まらない', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig({ maxRounds: 1 }));

  const adapters = {
    a: alwaysSpeakAdapter('A'),
    b: alwaysSpeakAdapter('B'),
  };

  const result = await runDebate({
    stateDir,
    board,
    adapters,
    onEvent: () => {
      throw new Error('GUI側の例外');
    },
  });

  assert.equal(result.meta.status, 'ended');
  assert.equal(result.meta.round, 1);
});

test('enabledな参加者が2人未満なら即終了（endedBy=noParticipants）', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, {
    maxRounds: 4,
    participants: [
      { id: 'a', name: 'A', adapter: 'claude', enabled: true },
      { id: 'b', name: 'B', adapter: 'codex', enabled: false },
    ],
  });

  let called = 0;
  const adapters = {
    a: { async speak() { called += 1; return { pass: true }; } },
  };
  const events = [];

  const result = await runDebate({ stateDir, board, adapters, onEvent: (e) => events.push(e) });

  assert.equal(called, 0);
  assert.equal(result.meta.status, 'ended');
  assert.equal(result.meta.endedBy, 'noParticipants');
  assert.equal(result.summary, null);
  assert.ok(events.some((e) => e.type === 'warning'));
  assert.ok(events.some((e) => e.type === 'ended' && e.endedBy === 'noParticipants'));
});

test('シンセシス担当は配列順で最初のenabled＋adapter登録ありのnon-human', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, {
    maxRounds: 1,
    participants: [
      { id: 'you', name: 'あなた', adapter: 'human', enabled: true },
      { id: 'a', name: 'A', adapter: 'claude', enabled: true }, // adapter未登録
      { id: 'b', name: 'B', adapter: 'codex', enabled: true },
    ],
  });

  const adapters = {
    you: { async speak() { return { utterance: '', cardOps: [], pass: true }; } },
    // a は登録なし → ラウンド中はpass扱い、シンセシス担当にも選ばれない
    b: {
      async speak(ctx) {
        if (ctx.transcriptTail !== undefined) {
          return { summary: 'Bによる総括' };
        }
        return { utterance: '発言B', cardOps: [], pass: true };
      },
    },
  };

  const result = await runDebate({ stateDir, board, adapters });

  assert.equal(result.summary, 'Bによる総括');
});

test('不正なTurnResult（utterance非string/cardOps非配列）はpass+errorに正規化される', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig({ maxRounds: 1 }));

  const adapters = {
    a: { async speak() { return { utterance: 123, cardOps: [], pass: false }; } },
    b: { async speak() { return { utterance: 'ok', cardOps: 'not-an-array', pass: false }; } },
  };

  await runDebate({ stateDir, board, adapters });

  const { entries } = loadTranscript(stateDir, board.meta.id);
  const aEntry = entries.find((e) => e.participantId === 'a');
  const bEntry = entries.find((e) => e.participantId === 'b');
  assert.equal(aEntry.pass, true);
  assert.ok(aEntry.error.includes('utterance'));
  assert.equal(bEntry.pass, true);
  assert.ok(bEntry.error.includes('cardOps'));
});

test('loadTranscriptは壊れた行をskipしてwarningsに積む', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig());
  appendTranscript(stateDir, board.meta.id, { round: 1, participantId: 'a', utterance: '正常行' });
  fs.appendFileSync(
    path.join(stateDir, board.meta.id, 'transcript.jsonl'),
    '{ これはJSONではない\n',
    'utf8'
  );
  appendTranscript(stateDir, board.meta.id, { round: 1, participantId: 'b', utterance: '正常行2' });

  const { entries, warnings } = loadTranscript(stateDir, board.meta.id);
  assert.equal(entries.length, 2);
  assert.equal(warnings.length, 1);
});

test('TURN_SCHEMAは厳格JSON Schema互換（全property required・nullable・items必須）', () => {
  // トップレベル: 全propertyがrequired
  assert.deepEqual(
    [...TURN_SCHEMA.required].sort(),
    ['cardOps', 'noteUpdate', 'pass', 'utterance']
  );
  assert.equal(TURN_SCHEMA.additionalProperties, false);
  // cardOpsのitemsが定義されている（codex --output-schemaの400対策）
  const item = TURN_SCHEMA.properties.cardOps.items;
  assert.ok(item && item.type === 'object');
  assert.deepEqual(
    [...item.required].sort(),
    ['body', 'cardId', 'lane', 'op', 'title']
  );
  assert.equal(item.additionalProperties, false);
  // 省略可能フィールドはnullable
  assert.deepEqual(item.properties.cardId.type, ['string', 'null']);
  assert.deepEqual(item.properties.lane.type, ['string', 'null']);
  assert.deepEqual(item.properties.title.type, ['string', 'null']);
  assert.deepEqual(item.properties.body.type, ['string', 'null']);
  assert.deepEqual(TURN_SCHEMA.properties.noteUpdate.type, ['string', 'null']);
});

test('applyCardOps: 厳格スキーマ形（null埋め）のcardOpsを未指定として扱う', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig());

  // add: cardIdはnullで来る（正常）
  let r = applyCardOps(
    board,
    [{ op: 'add', cardId: null, lane: 'discussing', title: '論点X', body: '本文X' }],
    'a'
  );
  assert.equal(r.applied.length, 1);
  assert.equal(r.warnings.length, 0);
  const cardId = board.cards[0].id;

  // move: title/bodyはnullで来る（正常）
  r = applyCardOps(board, [{ op: 'move', cardId, lane: 'decided', title: null, body: null }], 'a');
  assert.equal(r.applied.length, 1);
  assert.equal(r.warnings.length, 0);
  assert.equal(board.cards[0].lane, 'decided');

  // edit: bodyだけ更新、title:nullは未指定扱い（警告なし）
  r = applyCardOps(board, [{ op: 'edit', cardId, lane: null, title: null, body: '更新後' }], 'a');
  assert.equal(r.applied.length, 1);
  assert.equal(r.warnings.length, 0);
  assert.equal(board.cards[0].title, '論点X'); // titleは維持
  assert.equal(board.cards[0].body, '更新後');

  // 不正: add で lane:null → warning
  r = applyCardOps(board, [{ op: 'add', cardId: null, lane: null, title: 't', body: null }], 'a');
  assert.equal(r.applied.length, 0);
  assert.equal(r.warnings.length, 1);

  // 不正: add で title:null → warning
  r = applyCardOps(board, [{ op: 'add', cardId: null, lane: 'held', title: null, body: null }], 'a');
  assert.equal(r.applied.length, 0);
  assert.equal(r.warnings.length, 1);

  // 不正: move で lane:null → warning
  r = applyCardOps(board, [{ op: 'move', cardId, lane: null, title: null, body: null }], 'a');
  assert.equal(r.applied.length, 0);
  assert.equal(r.warnings.length, 1);

  // 不正: edit で title/bodyとも null → 「どちらも指定なし」warning
  r = applyCardOps(board, [{ op: 'edit', cardId, lane: null, title: null, body: null }], 'a');
  assert.equal(r.applied.length, 0);
  assert.equal(r.warnings.length, 1);
});

test('noteUpdate: null はNOTE更新なしとして扱われる', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig({ maxRounds: 2 }));

  const adapters = {
    a: {
      async speak(ctx) {
        if (ctx.round === 1) {
          return { utterance: 'R1', cardOps: [], noteUpdate: 'R1のメモ', pass: false };
        }
        return { utterance: 'R2', cardOps: [], noteUpdate: null, pass: false };
      },
    },
    b: alwaysSpeakAdapter('B'),
  };

  await runDebate({ stateDir, board, adapters });

  // R2の noteUpdate:null で上書きされず、R1のメモが残る
  assert.equal(board.notes.a, 'R1のメモ');
});

// --------------------------------------------------------------------
// 参加AIルール（board.meta.rules → プロンプト注入）
// --------------------------------------------------------------------

test('buildTurnPrompt: rules非空で「--- ルール（厳守） ---」セクションがお題直後に入る', () => {
  const board = { cards: [] };
  const args = {
    participant: { id: 'a', name: 'A' },
    topic: TOPIC,
    round: 1,
    maxRounds: 2,
    board,
    ownNote: '',
    recentTranscript: [],
  };
  const withRules = buildTurnPrompt({ ...args, rules: 'ダミールール本文' });
  assert.ok(withRules.includes('--- ルール（厳守） ---'));
  assert.ok(withRules.includes('ダミールール本文'));
  // お題の直後（かんばん要約より前）に挿入されている
  assert.ok(withRules.indexOf('--- ルール（厳守） ---') > withRules.indexOf(`お題: ${TOPIC}`));
  assert.ok(withRules.indexOf('--- ルール（厳守） ---') < withRules.indexOf('--- 現在のかんばん'));

  const without = buildTurnPrompt(args);
  assert.ok(!without.includes('--- ルール（厳守） ---'));
  const empty = buildTurnPrompt({ ...args, rules: '   ' });
  assert.ok(!empty.includes('--- ルール（厳守） ---'));
});

test('buildSynthesisPrompt: rules有り/無しのセクション挿入', () => {
  const board = { cards: [] };
  const withRules = buildSynthesisPrompt({ topic: TOPIC, board, transcriptTail: [], rules: 'ダミールール' });
  assert.ok(withRules.includes('--- ルール（厳守） ---'));
  assert.ok(withRules.indexOf('--- ルール（厳守） ---') > withRules.indexOf(`お題: ${TOPIC}`));
  const without = buildSynthesisPrompt({ topic: TOPIC, board, transcriptTail: [] });
  assert.ok(!without.includes('--- ルール（厳守） ---'));
});

test('composeRulesFor: default→共通→個別の順で非空だけ結合し、全部空なら""', () => {
  const rules = {
    defaultSnapshot: 'ダミーデフォルト',
    common: 'ダミー共通',
    byId: { a: 'Aのダミー個別', b: 'Bのダミー個別' },
  };
  const forA = composeRulesFor(rules, 'a');
  assert.equal(
    forA,
    'ダミーデフォルト\n\n## この議論の共通ルール\nダミー共通\n\n## あなたの個別ルール\nAのダミー個別'
  );
  // 他人の個別ルールは入らない
  assert.ok(!forA.includes('Bのダミー個別'));

  // participantId無し（シンセシス）は default+common のみ
  const forSynthesis = composeRulesFor(rules, null);
  assert.equal(forSynthesis, 'ダミーデフォルト\n\n## この議論の共通ルール\nダミー共通');

  // 空要素はセクションごと省略
  assert.equal(composeRulesFor({ defaultSnapshot: '', common: 'だけ共通', byId: {} }, 'a'), '## この議論の共通ルール\nだけ共通');
  assert.equal(composeRulesFor({ defaultSnapshot: '', common: '', byId: {} }, 'a'), '');
  assert.equal(composeRulesFor(null, 'a'), '');
  // 後方互換: string渡しはそのまま
  assert.equal(composeRulesFor('旧形式ダミー', 'a'), '旧形式ダミー');
});

test('createDebate: meta.rulesが3層形式で保存されresume（loadDebate）後も保持される', () => {
  const stateDir = makeStateDir();
  const rules = { defaultSnapshot: 'デフォD', common: '共通C', byId: { a: '個別A' } };
  const board = createDebate(stateDir, TOPIC, baseConfig({ rules }));
  assert.deepEqual(board.meta.rules, rules);
  const reloaded = loadDebate(stateDir, board.meta.id);
  assert.deepEqual(reloaded.meta.rules, rules);

  // rules未指定なら全て空
  const board2 = createDebate(stateDir, TOPIC, baseConfig());
  assert.deepEqual(board2.meta.rules, { defaultSnapshot: '', common: '', byId: {} });
});

test('loadDebate: 旧string形式のrulesは{defaultSnapshot:"",common:旧,byId:{}}へ変換される（後方互換）', () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig());
  // 旧形式のboard.jsonを直接作って読み直す
  board.meta.rules = '旧形式のダミールール文字列';
  saveBoard(stateDir, board);
  const reloaded = loadDebate(stateDir, board.meta.id);
  assert.deepEqual(reloaded.meta.rules, {
    defaultSnapshot: '',
    common: '旧形式のダミールール文字列',
    byId: {},
  });
});

test('engine: 3層rulesが参加者ごとに合成されctx.rules/promptTextへ届く（シンセシスはdefault+commonのみ）', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig({
    maxRounds: 1,
    rules: { defaultSnapshot: 'デフォ注入D', common: '共通注入C', byId: { a: 'A個別注入' } },
  }));

  const seen = { aCtxRules: null, aPromptOk: false, bHasAOwn: null, synthPrompt: null };
  const adapters = {
    a: {
      async speak(ctx) {
        if (ctx.round !== undefined) {
          seen.aCtxRules = ctx.rules;
          seen.aPromptOk =
            ctx.promptText.includes('--- ルール（厳守） ---') &&
            ctx.promptText.includes('デフォ注入D') &&
            ctx.promptText.includes('## この議論の共通ルール\n共通注入C') &&
            ctx.promptText.includes('## あなたの個別ルール\nA個別注入');
        } else {
          seen.synthPrompt = ctx.promptText; // シンセシスターン（roundなし）
        }
        return { utterance: '発言', cardOps: [], pass: false };
      },
    },
    b: {
      async speak(ctx) {
        seen.bHasAOwn = ctx.promptText.includes('A個別注入');
        return { utterance: 'B発言', cardOps: [], pass: false };
      },
    },
  };

  await runDebate({ stateDir, board, adapters });

  assert.equal(
    seen.aCtxRules,
    'デフォ注入D\n\n## この議論の共通ルール\n共通注入C\n\n## あなたの個別ルール\nA個別注入'
  );
  assert.equal(seen.aPromptOk, true);
  assert.equal(seen.bHasAOwn, false); // BのプロンプトにAの個別は入らない
  assert.ok(seen.synthPrompt.includes('デフォ注入D'));
  assert.ok(seen.synthPrompt.includes('共通注入C'));
  assert.ok(!seen.synthPrompt.includes('A個別注入')); // シンセシスは個別なし
});

// --------------------------------------------------------------------
// 発言中インジケータ用イベント（turn-start / synthesis-start）
// --------------------------------------------------------------------

test('turn-startがspeak前に発行され、turn-start→turnの対が全ターン分そろう', async () => {
  const stateDir = makeStateDir();
  const board = createDebate(stateDir, TOPIC, baseConfig({ maxRounds: 2 }));

  const events = [];
  let speakingAtSpeakTime = [];
  const mk = (label) => ({
    async speak(ctx) {
      if (ctx.round !== undefined) {
        // speak時点で自分のturn-startが既に発行されていること（speak「直前」の検証）
        const last = events[events.length - 1];
        speakingAtSpeakTime.push(
          last && last.type === 'turn-start' && last.participantId === ctx.participant.id && last.round === ctx.round
        );
      }
      return { utterance: `${label}R${ctx.round ?? '-'}`, cardOps: [], pass: false };
    },
  });

  await runDebate({
    stateDir,
    board,
    adapters: { a: mk('A'), b: mk('B') },
    onEvent: (e) => events.push(e),
  });

  // speak呼び出し時点で直前イベントが自分のturn-startだった
  assert.ok(speakingAtSpeakTime.length >= 4);
  assert.ok(speakingAtSpeakTime.every(Boolean));

  // turn-start→turn の対（同round・同participantId）が全ターン分
  const starts = events.filter((e) => e.type === 'turn-start');
  const turns = events.filter((e) => e.type === 'turn');
  assert.equal(starts.length, 4); // 2ラウンド x 2参加者
  assert.equal(turns.length, 4);
  for (let i = 0; i < turns.length; i++) {
    assert.equal(starts[i].participantId, turns[i].participantId);
    assert.equal(starts[i].round, turns[i].round);
    // 順序: 各turnの前に対応するturn-startが来ている
    assert.ok(events.indexOf(starts[i]) < events.indexOf(turns[i]));
  }

  // synthesis-startがendedより前に発行されている
  const synthIdx = events.findIndex((e) => e.type === 'synthesis-start');
  const endedIdx = events.findIndex((e) => e.type === 'ended');
  assert.ok(synthIdx !== -1, 'synthesis-startが発行されること');
  assert.ok(endedIdx !== -1);
  assert.ok(synthIdx < endedIdx);
  assert.equal(events[synthIdx].participantId, 'a'); // 先頭のenabled AI
});
