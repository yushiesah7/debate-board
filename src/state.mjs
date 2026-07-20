/**
 * state.mjs — board.json / transcript.jsonl の読み書き（純ロジック、依存は node:fs / node:path / node:crypto のみ）
 *
 * ディレクトリレイアウト:
 *   <stateDir>/<debateId>/board.json
 *   <stateDir>/<debateId>/transcript.jsonl
 *
 * board.json の形:
 *   {
 *     meta: { id, topic, status, round, maxRounds, rules, cardSeq, createdAt, updatedAt, endedBy? },
 *       - round は「完了したラウンド番号」（ラウンド完了時にのみ確定書き込みされる）
 *       - rules は参加AIの行動ルール3層 { defaultSnapshot, common, byId }:
 *           defaultSnapshot = start時の PARTICIPANT_RULES.md の内容を固定保存（string）
 *           common          = その場の共通ルール（string、git外＝boardにのみ保存）
 *           byId            = その場の個別ルール { <participantId>: string }
 *         旧形式（string）のboardは loadDebate が
 *         { defaultSnapshot:"", common:<旧文字列>, byId:{} } へ変換する（後方互換）
 *       - endedBy は終了時のみ: "maxRounds" | "allPass" | "ending" | "noParticipants"
 *     participants: [{ id, name, adapter, model?, endpoint?, persona?, enabled, pcAccess, effort?, session? }, ...],
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
 * rules値を3層形式 { defaultSnapshot, common, byId } に正規化する。
 * - オブジェクト: 各フィールドを型チェックしつつコピー（byIdはstring値のみ採用）
 * - 旧string形式: { defaultSnapshot:"", common:<旧文字列>, byId:{} } へ変換（後方互換）
 * - それ以外（null/undefined等）: 全て空
 * @param {unknown} value
 * @returns {{defaultSnapshot: string, common: string, byId: Object<string, string>}}
 */
export function normalizeRules(value) {
  if (typeof value === 'string') {
    return { defaultSnapshot: '', common: value, byId: {} };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = /** @type {Record<string, unknown>} */ (value);
    const byId = {};
    if (obj.byId && typeof obj.byId === 'object' && !Array.isArray(obj.byId)) {
      for (const [pid, text] of Object.entries(obj.byId)) {
        if (typeof text === 'string' && text !== '') byId[pid] = text;
      }
    }
    return {
      defaultSnapshot: typeof obj.defaultSnapshot === 'string' ? obj.defaultSnapshot : '',
      common: typeof obj.common === 'string' ? obj.common : '',
      byId,
    };
  }
  return { defaultSnapshot: '', common: '', byId: {} };
}

/**
 * 新しい議論を作成し、state ディレクトリと board.json / transcript.jsonl を初期化する。
 *
 * @param {string} stateDir - state ルートディレクトリ（例: "state"）
 * @param {string} topic - お題
 * @param {{maxRounds?: number, rules?: {defaultSnapshot?:string, common?:string, byId?:Object<string,string>}|string, participants: Array<{id:string,name:string,adapter:string,model?:string,endpoint?:string,persona?:string,enabled:boolean}>}} config
 *   - rules: 参加AIの行動ルール3層（string渡しは旧形式としてcommonへ正規化。ファイル読込・合成はサーバ/CLI側の責務）
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
    // pcAccess/effort: CLIアダプタ(claude/codex/grok)がctx.participantから直接読む
    // フィールド（SPEC §2）。ここで落とすと config/POST /api/participant で
    // 設定しても実行中の議論には一切反映されなくなるので、必ず引き継ぐ。
    pcAccess: p.pcAccess ?? 'read',
    effort: p.effort ?? null,
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
      rules: normalizeRules(config?.rules),
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
  const board = JSON.parse(raw);
  // 後方互換: 旧形式（rulesがstring）や欠落を3層形式へ正規化する
  if (board?.meta) {
    board.meta.rules = normalizeRules(board.meta.rules);
  }
  return board;
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
 * cardId/lane/title/body の null は「未指定」と同義として扱う
 * （厳格JSON Schema対応のTURN_SCHEMAでは未使用フィールドが null で来るため）。
 * board は破壊的に変更される（呼び出し側は同じ参照を使い続けてよい）。
 *
 * @param {object} board
 * @param {Array<{op:string, cardId?:string|null, lane?:string|null, title?:string|null, body?:string|null}>} cardOps
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
    if (op.op == null) {
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
      // null は「未指定」と同義（厳格スキーマの全required+nullable流儀に対応。TURN_SCHEMA参照）
      if (op.title == null && op.body == null) {
        warnings.push(`edit: title/bodyのどちらも指定なし (cardId=${op.cardId})`);
        continue;
      }
      let edited = false;
      if (op.title != null) {
        if (typeof op.title === 'string') {
          card.title = op.title;
          edited = true;
        } else {
          warnings.push(`edit: titleがstringではありません (cardId=${op.cardId})`);
        }
      }
      if (op.body != null) {
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
