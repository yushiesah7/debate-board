/**
 * state.mjs — board.json / transcript.jsonl の読み書き（純ロジック、依存は node:fs / node:path / node:crypto のみ）
 *
 * ディレクトリレイアウト:
 *   <stateDir>/<debateId>/board.json
 *   <stateDir>/<debateId>/transcript.jsonl
 *
 * board.json の形:
 *   {
 *     meta: { id, topic, status, round, maxRounds, cardSeq, createdAt, updatedAt, endedBy? },
 *       - round は「完了したラウンド番号」（ラウンド完了時にのみ確定書き込みされる）
 *       - endedBy は終了時のみ: "maxRounds" | "allPass" | "ending" | "noParticipants"
 *     participants: [{ id, name, adapter, model?, endpoint?, persona?, enabled, session? }, ...],
 *     cards: [{ id, lane, title, body, createdBy, updatedBy, updatedAt }, ...],
 *     notes: { [participantId]: string },
 *     summary: string | null
 *   }
 *
 * status は "running" | "ending" | "ended"。
 * "ending" は外部（GUI等）が終了指示を出したことをエンジンに伝えるためのフラグ。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LANES = ['decided', 'discussing', 'held'];

/**
 * 新しい議論を作成し、state ディレクトリと board.json / transcript.jsonl を初期化する。
 *
 * @param {string} stateDir - state ルートディレクトリ（例: "state"）
 * @param {string} topic - お題
 * @param {{maxRounds?: number, participants: Array<{id:string,name:string,adapter:string,model?:string,endpoint?:string,persona?:string,enabled:boolean}>}} config
 * @returns {object} 作成された board オブジェクト（board.meta.id に debateId が入る）
 */
export function createDebate(stateDir, topic, config) {
  const debateId = crypto.randomUUID();
  const now = new Date().toISOString();

  const participants = (config?.participants ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    adapter: p.adapter,
    model: p.model ?? null,
    endpoint: p.endpoint ?? null,
    persona: p.persona ?? null,
    enabled: !!p.enabled,
    session: null,
  }));

  const notes = {};
  for (const p of participants) notes[p.id] = '';

  const board = {
    meta: {
      id: debateId,
      topic,
      status: 'running',
      round: 0,
      maxRounds: config?.maxRounds ?? 4,
      cardSeq: 1,
      createdAt: now,
      updatedAt: now,
    },
    participants,
    cards: [],
    notes,
    summary: null,
  };

  const dir = path.join(stateDir, debateId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), '', 'utf8');
  saveBoard(stateDir, board);

  return board;
}

/**
 * 既存の議論を読み込む。
 *
 * @param {string} stateDir
 * @param {string} debateId
 * @returns {object} board オブジェクト
 */
export function loadDebate(stateDir, debateId) {
  const boardPath = path.join(stateDir, debateId, 'board.json');
  const raw = fs.readFileSync(boardPath, 'utf8');
  return JSON.parse(raw);
}

/**
 * board を board.json に保存する（updatedAt を更新）。
 * 書き込みは原子的: 同ディレクトリの一時ファイルに書いてから renameSync で置き換える。
 * 途中でクラッシュしても board.json が中途半端な内容になることはない。
 *
 * @param {string} stateDir
 * @param {object} board - board.meta.id を含んでいること
 * @returns {void}
 */
export function saveBoard(stateDir, board) {
  board.meta.updatedAt = new Date().toISOString();
  const dir = path.join(stateDir, board.meta.id);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'board.json');
  const tmp = path.join(dir, 'board.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

/**
 * transcript.jsonl に1行追記する。
 *
 * @param {string} stateDir
 * @param {string} debateId
 * @param {object} entry - JSON化可能な任意オブジェクト（entry.timestamp があればそれを尊重、なければ現在時刻を付与）
 * @returns {void}
 */
export function appendTranscript(stateDir, debateId, entry) {
  const record = { ...entry, timestamp: entry.timestamp ?? new Date().toISOString() };
  const filePath = path.join(stateDir, debateId, 'transcript.jsonl');
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * transcript.jsonl を行単位で読み込みパースする。
 * 壊れた行（JSONとして不正な行）はスキップして warnings に行番号つきで積む。
 * ファイルが存在しない・読めない場合は entries=[] + warning 1件を返す（例外は投げない）。
 *
 * @param {string} stateDir
 * @param {string} debateId
 * @returns {{entries: Array<object>, warnings: string[]}}
 */
export function loadTranscript(stateDir, debateId) {
  const filePath = path.join(stateDir, debateId, 'transcript.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { entries: [], warnings: ['transcript.jsonl を読み込めませんでした'] };
  }
  const entries = [];
  const warnings = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      warnings.push(`transcript ${i + 1}行目がJSONとして不正なためスキップしました`);
    }
  }
  return { entries, warnings };
}

/**
 * cardOps を board.cards に機械的に適用する。
 * 不正な op（存在しない cardId・不正な lane・不明な op種別など）は適用せず warnings に積む。
 * board は破壊的に変更される（呼び出し側は同じ参照を使い続けてよい）。
 *
 * @param {object} board
 * @param {Array<{op:string, cardId?:string, lane?:string, title?:string, body?:string}>} cardOps
 * @param {string} byId - 操作した participant id（createdBy/updatedBy に記録）
 * @returns {{applied: Array<object>, warnings: string[]}}
 */
export function applyCardOps(board, cardOps, byId) {
  const applied = [];
  const warnings = [];
  const ops = Array.isArray(cardOps) ? cardOps : [];

  for (const rawOp of ops) {
    if (!rawOp || typeof rawOp !== 'object' || Array.isArray(rawOp)) {
      warnings.push('cardOpがオブジェクトではありません');
      continue;
    }
    const op = rawOp;
    if (op.op === undefined) {
      warnings.push('cardOpにopフィールドがありません');
      continue;
    }
    const now = new Date().toISOString();

    if (op.op === 'add') {
      if (!LANES.includes(op.lane)) {
        warnings.push(`add: 不正なlane "${op.lane}"`);
        continue;
      }
      if (!op.title || typeof op.title !== 'string') {
        warnings.push('add: titleが必要です');
        continue;
      }
      const id = `c${board.meta.cardSeq}`;
      board.meta.cardSeq += 1;
      const card = {
        id,
        lane: op.lane,
        title: op.title,
        body: typeof op.body === 'string' ? op.body : '',
        createdBy: byId,
        updatedBy: byId,
        updatedAt: now,
      };
      board.cards.push(card);
      applied.push({ op: 'add', card });
      continue;
    }

    if (op.op === 'move') {
      const card = board.cards.find((c) => c.id === op.cardId);
      if (!card) {
        warnings.push(`move: 存在しないcardId "${op.cardId}"`);
        continue;
      }
      if (!LANES.includes(op.lane)) {
        warnings.push(`move: 不正なlane "${op.lane}"`);
        continue;
      }
      card.lane = op.lane;
      card.updatedBy = byId;
      card.updatedAt = now;
      applied.push({ op: 'move', card });
      continue;
    }

    if (op.op === 'edit') {
      const card = board.cards.find((c) => c.id === op.cardId);
      if (!card) {
        warnings.push(`edit: 存在しないcardId "${op.cardId}"`);
        continue;
      }
      if (op.title === undefined && op.body === undefined) {
        warnings.push(`edit: title/bodyのどちらも指定なし (cardId=${op.cardId})`);
        continue;
      }
      let edited = false;
      if (op.title !== undefined) {
        if (typeof op.title === 'string') {
          card.title = op.title;
          edited = true;
        } else {
          warnings.push(`edit: titleがstringではありません (cardId=${op.cardId})`);
        }
      }
      if (op.body !== undefined) {
        if (typeof op.body === 'string') {
          card.body = op.body;
          edited = true;
        } else {
          warnings.push(`edit: bodyがstringではありません (cardId=${op.cardId})`);
        }
      }
      if (!edited) continue;
      card.updatedBy = byId;
      card.updatedAt = now;
      applied.push({ op: 'edit', card });
      continue;
    }

    warnings.push(`不明なop種別 "${op.op}"`);
  }

  return { applied, warnings };
}
