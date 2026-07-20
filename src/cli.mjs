#!/usr/bin/env node
// @ts-check
/**
 * cli.mjs — M1用のGUI無しターミナルランナー。
 *
 * Usage: node src/cli.mjs "お題" [ラウンド数] [今回の追加ルール]
 *
 * config.json（無ければ config.example.json）を読み込み、human参加者は
 * GUIが無いと入力できないため常に enabled=false へ強制してから議論を実行する。
 * 各ターンの発言・cardOps・ラウンド進行を整形して標準出力に流し、
 * 終了時に決定カード一覧とsummaryを表示する。
 *
 * state は `<repoRoot>/state/` に保存される（server.mjsと同じ既定ディレクトリ）。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from './config.mjs';
import { createDebate } from './state.mjs';
import { runDebate } from './engine.mjs';
import { resolveAdapter } from './adapters/index.mjs';
import { readDefaultRules, exportDebateArtifacts } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function printUsage() {
  console.error('使い方: node src/cli.mjs "お題" [ラウンド数] [今回の追加ルール]');
}

/**
 * @param {string[]} argv - process.argv.slice(2) 相当
 * @returns {Promise<void>}
 */
export async function main(argv) {
  const topic = argv[0];
  if (!topic || topic.trim() === '') {
    printUsage();
    process.exitCode = 1;
    return;
  }
  const roundsArg = argv[1] !== undefined ? Number.parseInt(argv[1], 10) : NaN;
  const extraRules = typeof argv[2] === 'string' ? argv[2] : '';

  const rootDir = path.join(__dirname, '..');
  const config = loadConfig(rootDir);
  const maxRounds = Number.isInteger(roundsArg) && roundsArg > 0 ? roundsArg : config.maxRounds;
  const stateDir = path.join(rootDir, 'state');

  // human参加者はターミナルには入力欄が無いので常にOFFへ強制する
  const participants = config.participants.map((p) =>
    p.adapter === 'human' ? { ...p, enabled: false } : { ...p }
  );

  const enabledCount = participants.filter((p) => p.enabled).length;
  if (enabledCount < 2) {
    console.error(
      'ONの参加者が2人未満のため開始できません（config.json / config.example.json を確認してください）'
    );
    process.exitCode = 1;
    return;
  }

  // ルール3層: デフォルト（PARTICIPANT_RULES.md。無ければ空）＋第3引数の追加ルール（common）
  const rules = {
    defaultSnapshot: readDefaultRules(path.join(rootDir, 'PARTICIPANT_RULES.md')),
    common: extraRules.trim(),
    byId: {},
  };
  const board = createDebate(stateDir, topic, { maxRounds, rules, participants });

  /** @type {Object<string, {speak: (ctx: object) => Promise<object>}>} */
  const adapters = {};
  for (const p of board.participants) {
    if (p.adapter === 'human') continue; // enabled=false固定なので呼ばれない
    adapters[p.id] = { speak: resolveAdapter(p.adapter) };
  }

  console.log('=== debate-board CLI ===');
  console.log(`お題: ${topic}`);
  console.log(`ラウンド数: ${maxRounds}`);
  console.log(
    `参加者: ${board.participants
      .filter((p) => p.enabled)
      .map((p) => p.name)
      .join(', ')}`
  );
  console.log('');

  let lastRound = 0;

  await runDebate({
    stateDir,
    board,
    adapters,
    onEvent(event) {
      if (event.type === 'turn') {
        if (event.round !== lastRound) {
          lastRound = event.round;
          console.log(`--- ラウンド ${event.round} ---`);
        }
        const entry = event.entry;
        const speaker = board.participants.find((p) => p.id === entry.participantId);
        const name = speaker ? speaker.name : entry.participantId;
        if (entry.pass) {
          console.log(`[${name}] (pass)${entry.error ? ` — error: ${entry.error}` : ''}`);
        } else {
          console.log(`[${name}] ${entry.utterance}`);
        }
        for (const applied of entry.cardOps ?? []) {
          const card = applied.card ?? {};
          console.log(`  card: ${applied.op} [${card.id ?? '?'}] "${card.title ?? ''}" (${card.lane ?? ''})`);
        }
        for (const w of entry.warnings ?? []) {
          console.log(`  警告: ${w}`);
        }
      } else if (event.type === 'warning') {
        for (const w of event.warnings ?? []) {
          console.log(`[警告] ${w}`);
        }
      } else if (event.type === 'ended') {
        console.log('');
        console.log(`=== 終了（${event.endedBy}） ===`);
      }
    },
  });

  console.log('');
  console.log('--- 決定カード一覧 (decided) ---');
  const decided = board.cards.filter((c) => c.lane === 'decided');
  if (decided.length === 0) {
    console.log('(なし)');
  } else {
    for (const c of decided) {
      console.log(`- [${c.id}] ${c.title}`);
      if (c.body) console.log(`    ${c.body}`);
    }
  }

  console.log('');
  console.log('--- 結論サマリ ---');
  console.log(board.summary ?? '(サマリなし)');

  // 議論終了時の自動エクスポート（サーバと同じrules/notesのJSON2ファイル）
  try {
    const dir = path.isAbsolute(config.autoExportDir)
      ? config.autoExportDir
      : path.join(rootDir, config.autoExportDir);
    const files = exportDebateArtifacts(dir, board);
    console.log('');
    console.log(`自動エクスポート: ${dir} に ${files.join(' / ')} を保存しました`);
  } catch (err) {
    console.error('自動エクスポートに失敗しました:', err?.message ?? err);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error('予期しないエラー:', err);
    process.exitCode = 1;
  });
}
