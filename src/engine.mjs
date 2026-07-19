/**
 * engine.mjs — ラウンド進行の純ロジック（SPEC §5, §6）。
 * CLIもHTTPも知らない。アダプタは { [participantId]: { speak(ctx) } } の形で注入される。
 *
 * adapter.speak(ctx) は Promise<TurnResult> を返す想定:
 *   TurnResult = { utterance?: string, cardOps?: Array, noteUpdate?: string, pass?: boolean, error?: string }
 * speak が reject した場合、エンジンはそれを pass 扱いにして続行する
 * （speak自体の例外処理・タイムアウト・リトライはアダプタ側の責務。SPEC/ARCHITECTURE参照）。
 */

import { saveBoard, appendTranscript, applyCardOps } from './state.mjs';
import { boardSummary, buildTurnPrompt, buildSynthesisPrompt, TURN_SCHEMA } from './prompt.mjs';

/**
 * @typedef {object} TurnResult
 * @property {string} [utterance]
 * @property {Array<object>} [cardOps]
 * @property {string} [noteUpdate]
 * @property {boolean} [pass]
 * @property {string} [error]
 */

/**
 * 直近2ラウンド分の発言を history から抜き出す。
 * @param {Array<object>} history
 * @param {number} round - 現在のラウンド番号
 * @returns {Array<object>}
 */
function recentSlice(history, round) {
  return history.filter((e) => e.round >= round - 1);
}

/**
 * board.participants のうち enabled のものを配列順（config順）で返す。
 * @param {object} board
 * @returns {Array<object>}
 */
function enabledParticipants(board) {
  return (board.participants ?? []).filter((p) => p.enabled);
}

/**
 * 議論を最後まで（または外部終了指示・maxRounds到達まで）進める純ロジック。
 *
 * @param {object} args
 * @param {string} args.stateDir - state ルートディレクトリ
 * @param {object} args.board - state.mjs の createDebate/loadDebate で得た board（破壊的に更新される）
 * @param {Object<string, {speak: (ctx: object) => Promise<TurnResult>}>} args.adapters - participantId をキーにしたアダプタ群
 * @param {(event: {type: string, [k: string]: any}) => void} [args.onEvent] - GUI通知等のためのコールバック（省略可）
 * @param {number} [args.humanTimeoutMs] - human参加者向けのタイムアウト目安（ctx経由でアダプタに渡すのみ。エンジン自体はタイムアウト処理をしない）
 * @returns {Promise<object>} 更新後の board（board.summary・board.meta.status="ended" が入った状態）
 */
export async function runDebate({ stateDir, board, adapters, onEvent, humanTimeoutMs }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  /** @type {Array<object>} このプロセス内で積み上がるtranscriptのメモリ上コピー（プロンプト組立用） */
  const history = [];

  const maxRounds = board.meta.maxRounds ?? 4;
  let endedByCondition = null;

  roundLoop: for (let round = board.meta.round + 1; round <= maxRounds; round++) {
    if (board.meta.status === 'ending') {
      endedByCondition = 'external';
      break roundLoop;
    }

    const participants = enabledParticipants(board);
    const passSet = new Set();

    for (const participant of participants) {
      if (board.meta.status === 'ending') {
        endedByCondition = 'external';
        break roundLoop;
      }

      const ctx = {
        participant,
        topic: board.meta.topic,
        round,
        maxRounds,
        boardSummary: boardSummary(board),
        ownNote: board.notes[participant.id] ?? '',
        recentTranscript: recentSlice(history, round),
        schemaJson: TURN_SCHEMA,
        humanTimeoutMs,
      };
      // buildTurnPrompt は完全なプロンプト文字列が欲しいアダプタ向けに用意しておく
      ctx.prompt = buildTurnPrompt({
        participant,
        topic: ctx.topic,
        round,
        maxRounds,
        board,
        ownNote: ctx.ownNote,
        recentTranscript: ctx.recentTranscript,
      });

      const adapter = adapters?.[participant.id];
      let result;
      try {
        result = adapter ? await adapter.speak(ctx) : { pass: true, error: 'no adapter registered' };
      } catch (err) {
        result = { pass: true, error: err?.message ?? String(err) };
      }
      if (!result || typeof result !== 'object') {
        result = { pass: true, error: 'invalid TurnResult' };
      }

      const utterance = typeof result.utterance === 'string' ? result.utterance : '';
      const pass = !!result.pass;
      const { applied, warnings } = applyCardOps(board, result.cardOps ?? [], participant.id);

      if (typeof result.noteUpdate === 'string') {
        board.notes[participant.id] = result.noteUpdate;
      }

      const entry = {
        round,
        participantId: participant.id,
        utterance,
        pass,
        cardOps: applied,
        warnings,
        error: result.error,
      };
      history.push(entry);
      appendTranscript(stateDir, board.meta.id, entry);

      board.meta.round = round;
      saveBoard(stateDir, board);

      emit({ type: 'turn', round, participantId: participant.id, entry, board });

      if (pass) passSet.add(participant.id);
    }

    // 終了条件2: ONの全AI（human除く）が同一ラウンドでpass
    const aiIds = participants.filter((p) => p.adapter !== 'human').map((p) => p.id);
    if (aiIds.length > 0 && aiIds.every((id) => passSet.has(id))) {
      endedByCondition = 'all-ai-pass';
      break roundLoop;
    }

    if (round >= maxRounds) {
      endedByCondition = 'max-rounds';
      break roundLoop;
    }
  }

  await runSynthesis({ stateDir, board, history, adapters, emit });

  return board;
}

/**
 * 終了後のシンセシスターン。config先頭のAI参加者（config配列順で最初に出現する adapter !== 'human' の参加者）に
 * 総括させ、結果を board.summary に保存する。担当者が見つからない場合や speak が失敗した場合は
 * summary は null のまま status を "ended" にする（エンジンは止まらない）。
 *
 * @param {object} args
 * @param {string} args.stateDir
 * @param {object} args.board
 * @param {Array<object>} args.history
 * @param {Object<string, {speak: (ctx: object) => Promise<TurnResult>}>} args.adapters
 * @param {(event: object) => void} args.emit
 * @returns {Promise<void>}
 */
async function runSynthesis({ stateDir, board, history, adapters, emit }) {
  const synthesisParticipant = (board.participants ?? []).find((p) => p.adapter !== 'human');

  let summary = null;
  if (synthesisParticipant) {
    const transcriptTail = history.slice(-20);
    const ctx = {
      participant: synthesisParticipant,
      topic: board.meta.topic,
      board,
      transcriptTail,
      prompt: buildSynthesisPrompt({ topic: board.meta.topic, board, transcriptTail }),
    };
    const adapter = adapters?.[synthesisParticipant.id];
    try {
      const result = adapter ? await adapter.speak(ctx) : null;
      if (result && typeof result === 'object') {
        summary = typeof result.summary === 'string' ? result.summary : (result.utterance ?? null);
      }
    } catch {
      summary = null;
    }
  }

  board.summary = summary;
  board.meta.status = 'ended';
  saveBoard(stateDir, board);
  emit({ type: 'ended', summary: board.summary, board });
}
