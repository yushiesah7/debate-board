/**
 * prompt.mjs — ボード要約・ターンプロンプト・シンセシスプロンプトの組立（全アダプタ共通、依存ゼロ）
 *
 * すべて日本語で組み立てる。CLI/HTTPアダプタはここで作った文字列をそのまま渡す。
 */

const LANE_LABELS = {
  decided: '✅ decided（決定事項）',
  discussing: '💬 discussing（議論中）',
  held: '⏸ held（保留）',
};

/**
 * board の3レーンかんばんを、各カード title + body1行 の形でテキスト要約する。
 *
 * @param {object} board - state.mjs の board オブジェクト
 * @returns {string}
 */
export function boardSummary(board) {
  const lanes = ['decided', 'discussing', 'held'];
  const lines = [];
  for (const lane of lanes) {
    lines.push(LANE_LABELS[lane]);
    const cards = (board.cards ?? []).filter((c) => c.lane === lane);
    if (cards.length === 0) {
      lines.push('  (なし)');
    } else {
      for (const c of cards) {
        const title = typeof c.title === 'string' ? c.title : '(無題)';
        const bodyLine = typeof c.body === 'string' ? c.body.split('\n')[0] : '';
        lines.push(`  - [${c.id}] ${title}: ${bodyLine}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * 直近の発言配列をプロンプト用テキストに整形する。
 * @param {Array<{round?:number, participantId?:string, utterance?:string, pass?:boolean}>} recentTranscript
 * @returns {string}
 */
function formatRecentTranscript(recentTranscript) {
  const entries = Array.isArray(recentTranscript) ? recentTranscript : [];
  if (entries.length === 0) return '(まだ発言はありません)';
  return entries
    .map((e) => {
      if (e.pass) return `[R${e.round}] ${e.participantId}: (pass)`;
      return `[R${e.round}] ${e.participantId}: ${e.utterance ?? ''}`;
    })
    .join('\n');
}

/**
 * SPEC §5 の出力契約（AI応答スキーマ）。JSON Schema オブジェクト（全アダプタ共通）。
 *
 * 厳格モード互換（codex --output-schema 等の strict JSON Schema）:
 * - 全propertyを required に入れ、省略可能なフィールドは nullable（type: ["string","null"]）で表現する流儀
 * - このため cardOps 各要素の cardId/lane/title/body、および noteUpdate は null で来ることがある。
 *   受け側（state.mjs の applyCardOps / engine.mjs）は「null＝未指定」として扱う
 */
export const TURN_SCHEMA = {
  type: 'object',
  properties: {
    utterance: { type: 'string' },
    cardOps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'move', 'edit'] },
          cardId: { type: ['string', 'null'] },
          lane: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] },
          body: { type: ['string', 'null'] },
        },
        required: ['op', 'cardId', 'lane', 'title', 'body'],
        additionalProperties: false,
      },
    },
    noteUpdate: { type: ['string', 'null'] },
    pass: { type: 'boolean' },
  },
  required: ['utterance', 'cardOps', 'noteUpdate', 'pass'],
  additionalProperties: false,
};

/**
 * ルール3層 { defaultSnapshot, common, byId } を、指定参加者向けの合成済み
 * ルール文字列にする純関数。
 * - defaultSnapshot（デフォルトルール=PARTICIPANT_RULES.mdのstart時スナップショット）はそのまま先頭
 * - common は「## この議論の共通ルール」見出し付き
 * - byId[participantId] は「## あなたの個別ルール」見出し付き
 * 非空のものだけを結合し、全部空なら "" を返す。
 * participantId が null/undefined（シンセシス等）なら個別ルールは付かない。
 * 後方互換: rulesObj が string ならそのままtrimして返す（旧形式）。
 *
 * @param {{defaultSnapshot?:string, common?:string, byId?:Object<string,string>}|string|null|undefined} rulesObj
 * @param {string|null} [participantId]
 * @returns {string}
 */
export function composeRulesFor(rulesObj, participantId) {
  if (typeof rulesObj === 'string') return rulesObj.trim();
  if (!rulesObj || typeof rulesObj !== 'object') return '';
  const parts = [];
  const def = typeof rulesObj.defaultSnapshot === 'string' ? rulesObj.defaultSnapshot.trim() : '';
  if (def) parts.push(def);
  const common = typeof rulesObj.common === 'string' ? rulesObj.common.trim() : '';
  if (common) parts.push(`## この議論の共通ルール\n${common}`);
  const own =
    participantId != null && rulesObj.byId && typeof rulesObj.byId[participantId] === 'string'
      ? rulesObj.byId[participantId].trim()
      : '';
  if (own) parts.push(`## あなたの個別ルール\n${own}`);
  return parts.join('\n\n');
}

/**
 * ルール文字列を「--- ルール（厳守） ---」セクションの行配列にする。
 * rules が空・未指定なら空配列（＝セクションごと省略）。
 * @param {string} [rules]
 * @returns {string[]}
 */
function rulesSection(rules) {
  if (typeof rules !== 'string' || rules.trim() === '') return [];
  return ['--- ルール（厳守） ---', rules.trim(), ''];
}

/**
 * 1ターン分のプロンプトを組み立てる（SPEC §5.1）。
 *
 * @param {object} args
 * @param {{id:string,name:string,persona?:string}} args.participant
 * @param {string} args.topic
 * @param {number} args.round
 * @param {number} args.maxRounds
 * @param {object} args.board
 * @param {string} [args.ownNote]
 * @param {Array<object>} [args.recentTranscript] - 直近2ラウンド分の発言
 * @param {string} [args.rules] - 参加AIの行動ルール（非空なら「--- ルール（厳守） ---」としてお題の直後に挿入）
 * @returns {string}
 */
export function buildTurnPrompt({ participant, topic, round, maxRounds, board, ownNote, recentTranscript, rules }) {
  const persona = participant?.persona ? `\nあなたのペルソナ: ${participant.persona}` : '';
  return [
    `あなたは議論の参加者「${participant?.name ?? participant?.id}」です。${persona}`,
    '',
    `お題: ${topic}`,
    `ラウンド: ${round} / ${maxRounds}`,
    '',
    ...rulesSection(rules),
    '--- 現在のかんばん（3レーン要約） ---',
    boardSummary(board),
    '',
    '--- あなた自身のNOTE ---',
    ownNote && ownNote.length > 0 ? ownNote : '(まだNOTEはありません)',
    '',
    '--- 直近の発言 ---',
    formatRecentTranscript(recentTranscript),
    '',
    '--- 指示 ---',
    'これまでの議論とかんばんを踏まえ、あなたの発言を日本語で述べてください。',
    '必要であればカード操作（cardOps）でかんばんを更新し、自分のNOTE（noteUpdate）を更新してください。',
    'これ以上議論を深める必要がないと判断したら pass を true にしてください。',
    '出力は必ず次のJSONスキーマに厳密に従うJSONのみとし、それ以外の文章を含めないでください。',
    'cardOps の各操作で使わないフィールドには null を入れてください',
    '（例: add では cardId を null に、move では title と body を null に）。',
    'カード操作が不要なら cardOps は空配列 [] に、NOTEを更新しない場合は noteUpdate を null にしてください。',
    JSON.stringify(TURN_SCHEMA, null, 2),
  ].join('\n');
}

/**
 * 終了後のシンセシス（総括）プロンプトを組み立てる（SPEC §6）。
 *
 * @param {object} args
 * @param {string} args.topic
 * @param {object} args.board
 * @param {Array<object>} [args.transcriptTail] - 直近の発言ログ（総括の材料）
 * @param {string} [args.rules] - 参加AIの行動ルール（非空なら「--- ルール（厳守） ---」としてお題の直後に挿入）
 * @returns {string}
 */
export function buildSynthesisPrompt({ topic, board, transcriptTail, rules }) {
  return [
    'あなたはこの議論のまとめ役です。',
    '',
    `お題: ${topic}`,
    '',
    ...rulesSection(rules),
    '--- 最終的なかんばん（3レーン要約） ---',
    boardSummary(board),
    '',
    '--- 終盤の発言 ---',
    formatRecentTranscript(transcriptTail),
    '',
    '--- 指示 ---',
    '以下を含む結論サマリを日本語で作成してください:',
    '1. decided（決定事項）の整理',
    '2. held（保留）の整理',
    '3. discussing（議論中）に残っている論点のリスト',
    '4. 全体の結論サマリ',
    '出力は次のJSONだけを返してください（サマリ全文を utterance に入れる。他の説明文は不要）:',
    '{"utterance": "<結論サマリ全文>", "cardOps": [], "noteUpdate": null, "pass": false}',
  ].join('\n');
}
