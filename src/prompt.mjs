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
        const bodyLine = (c.body ?? '').split('\n')[0];
        lines.push(`  - [${c.id}] ${c.title}: ${bodyLine}`);
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
 * SPEC §5 の出力契約（AI応答スキーマ）。JSON Schema オブジェクト。
 * additionalProperties: false（全アダプタ共通で使い回す）。
 */
export const TURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['utterance', 'cardOps', 'pass'],
  properties: {
    utterance: {
      type: 'string',
      description: '発言（日本語、400字以内目安）',
    },
    cardOps: {
      type: 'array',
      description: 'かんばんへの操作。不要なら空配列',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['add', 'move', 'edit'] },
          cardId: { type: 'string', description: 'move/edit時に必須' },
          lane: { type: 'string', enum: ['decided', 'discussing', 'held'] },
          title: { type: 'string', description: 'add/edit時' },
          body: { type: 'string', description: 'add/edit時' },
        },
      },
    },
    noteUpdate: {
      type: 'string',
      description: '自分のNOTE全文置換（省略可）',
    },
    pass: {
      type: 'boolean',
      description: 'このラウンドは発言をスキップするか',
    },
  },
};

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
 * @returns {string}
 */
export function buildTurnPrompt({ participant, topic, round, maxRounds, board, ownNote, recentTranscript }) {
  const persona = participant?.persona ? `\nあなたのペルソナ: ${participant.persona}` : '';
  return [
    `あなたは議論の参加者「${participant?.name ?? participant?.id}」です。${persona}`,
    '',
    `お題: ${topic}`,
    `ラウンド: ${round} / ${maxRounds}`,
    '',
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
 * @returns {string}
 */
export function buildSynthesisPrompt({ topic, board, transcriptTail }) {
  return [
    'あなたはこの議論のまとめ役です。',
    '',
    `お題: ${topic}`,
    '',
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
    '出力は summary という1つの文字列にまとめ、他の説明文は付けないでください。',
  ].join('\n');
}
