/**
 * engine.mjs — ラウンド進行の純ロジック（SPEC §5, §6）。
 * CLIもHTTPも知らない。アダプタは { [participantId]: { speak(ctx) } } の形で注入される。
 *
 * adapter.speak(ctx) は Promise<TurnResult> を返す想定:
 *   TurnResult = { utterance?: string, cardOps?: Array, noteUpdate?: string, pass?: boolean, error?: string }
 * speak が reject した場合、および応答の形が不正（utteranceが非string、cardOpsが非配列）な場合は
 * pass 扱い（error付き）にして続行する
 * （speak自体のタイムアウト・リトライはアダプタ側の責務。SPEC/ARCHITECTURE参照）。
 *
 * ## クラッシュ再開のセマンティクス
 * board.meta.round は「完了したラウンド番号」であり、ラウンド完了時にのみ書き込まれる。
 * ラウンド途中でクラッシュした場合、再開時はその未完ラウンドを頭からやり直す。
 * このため transcript.jsonl には同一ラウンドのターンが重複して残り得る
 * （transcriptは追記専用ログなので許容。board側の状態は最後に完了保存された時点が正）。
 */

import { saveBoard, appendTranscript, applyCardOps, loadTranscript } from './state.mjs';
import { boardSummary, buildTurnPrompt, buildSynthesisPrompt, TURN_SCHEMA } from './prompt.mjs';

/**
 * @typedef {object} TurnResult
 * @property {string} [utterance]
 * @property {Array<object>} [cardOps]
 * @property {string} [noteUpdate]
 * @property {boolean} [pass]
 * @property {string} [error]
 * @property {string} [summary] - シンセシスターンでのみ使用
 */

/**
 * 直近2ラウンド分（round-2 以降）の発言を history から抜き出す。
 * @param {Array<object>} history
 * @param {number} round - 現在のラウンド番号
 * @returns {Array<object>}
 */
function recentSlice(history, round) {
  return history.filter((e) => typeof e.round === 'number' && e.round >= round - 2);
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
 * TurnResult の最低限バリデーション。形が不正なら pass+error に正規化する。
 * @param {any} result
 * @returns {TurnResult}
 */
function normalizeTurnResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { pass: true, error: 'invalid TurnResult: not an object' };
  }
  if (result.utterance !== undefined && typeof result.utterance !== 'string') {
    return { pass: true, error: 'invalid TurnResult: utterance must be a string' };
  }
  if (result.cardOps !== undefined && !Array.isArray(result.cardOps)) {
    return { pass: true, error: 'invalid TurnResult: cardOps must be an array' };
  }
  return result;
}

/**
 * 議論を最後まで（または外部終了指示・maxRounds到達まで）進める純ロジック。
 *
 * - board.meta.status === "ended" の board を渡された場合は何もせず即 return する（no-op）
 * - 開始時に transcript.jsonl から完了済みラウンド分の履歴を復元する（クラッシュ再開対応）
 * - enabled な参加者が2人未満なら即終了（endedBy: "noParticipants"、summaryなし、warningイベントemit）
 * - onEvent が例外を投げても進行は止まらない（握りつぶす）
 *
 * 終了時に board.meta.endedBy に終了理由が入る:
 *   "maxRounds" | "allPass" | "ending"（外部終了指示） | "noParticipants"
 *
 * @param {object} args
 * @param {string} args.stateDir - state ルートディレクトリ
 * @param {object} args.board - state.mjs の createDebate/loadDebate で得た board（破壊的に更新される）
 * @param {Object<string, {speak: (ctx: object) => Promise<TurnResult>}>} args.adapters - participantId をキーにしたアダプタ群
 * @param {(event: {type: string, [k: string]: any}) => void} [args.onEvent] - GUI通知等のためのコールバック（省略可。例外はエンジンが握る）
 * @param {number} [args.humanTimeoutMs] - human参加者向けのタイムアウト目安（ctx経由でアダプタに渡すのみ。エンジン自体はタイムアウト処理をしない）
 * @returns {Promise<object>} 更新後の board（board.summary・board.meta.status="ended"・board.meta.endedBy が入った状態）
 */
export async function runDebate({ stateDir, board, adapters, onEvent, humanTimeoutMs }) {
  // #4: onEventの例外で進行を止めない
  const emit = (event) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(event);
    } catch {
      /* onEventの例外は無視（エンジンは止まらない） */
    }
  };

  // #5: 終了済みboardはno-op
  if (board.meta.status === 'ended') {
    return board;
  }

  const maxRounds = board.meta.maxRounds ?? 4;

  // #2: クラッシュ再開対応 — transcriptから履歴を復元。
  // 完了済みラウンド（round <= board.meta.round）のみ採用し、
  // 未完ラウンドの中途エントリは文脈に含めない（そのラウンドは頭からやり直すため）。
  const { entries: restored, warnings: transcriptWarnings } = loadTranscript(stateDir, board.meta.id);
  const history = restored.filter(
    (e) => typeof e.round === 'number' && e.round <= board.meta.round
  );
  if (transcriptWarnings.length > 0) {
    emit({ type: 'warning', warnings: transcriptWarnings });
  }

  // #9: enabledが2人未満なら即終了
  if (enabledParticipants(board).length < 2) {
    board.meta.endedBy = 'noParticipants';
    board.meta.status = 'ended';
    saveBoard(stateDir, board);
    emit({ type: 'warning', warnings: ['enabledな参加者が2人未満のため議論を開始できません'] });
    emit({ type: 'ended', endedBy: board.meta.endedBy, summary: board.summary, board });
    return board;
  }

  let endedBy = null;

  roundLoop: for (let round = board.meta.round + 1; round <= maxRounds; round++) {
    if (board.meta.status === 'ending') {
      endedBy = 'ending';
      break roundLoop;
    }

    // トグルはラウンド境界で反映（SPEC §2）
    const participants = enabledParticipants(board);
    const passSet = new Set();

    for (const participant of participants) {
      if (board.meta.status === 'ending') {
        endedBy = 'ending';
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
      result = normalizeTurnResult(result); // #6

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

      // #1: board.meta.round はここでは進めない（ラウンド完了時のみ）。
      // カード・NOTEの途中経過は保存する。
      saveBoard(stateDir, board);

      emit({ type: 'turn', round, participantId: participant.id, entry, board });

      if (pass) passSet.add(participant.id);
    }

    // #1: ラウンド完了時にのみ round を確定
    board.meta.round = round;
    saveBoard(stateDir, board);

    // 終了条件2: ONの全AI（human除く）が同一ラウンドでpass
    const aiIds = participants.filter((p) => p.adapter !== 'human').map((p) => p.id);
    if (aiIds.length > 0 && aiIds.every((id) => passSet.has(id))) {
      endedBy = 'allPass';
      break roundLoop;
    }
  }

  if (endedBy === null) {
    endedBy = board.meta.status === 'ending' ? 'ending' : 'maxRounds';
  }
  board.meta.endedBy = endedBy; // #11

  await runSynthesis({ stateDir, board, history, adapters, emit });

  return board;
}

/**
 * 終了後のシンセシスターン。担当は「config配列順で最初の、enabled かつ adapter登録あり の non-human 参加者」
 * （#10 司令塔裁定: 有効な先頭AI）。総括結果を board.summary に保存する。
 * 担当者が見つからない場合や speak が失敗した場合は summary は null のまま status を "ended" にする
 * （エンジンは止まらない）。
 *
 * シンセシス用の ctx には transcriptTail（終盤の発言）と prompt（buildSynthesisPromptの結果）が入る。
 * アダプタは TurnResult.summary（string）または utterance を返せばよい。
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
  const synthesisParticipant = (board.participants ?? []).find(
    (p) => p.enabled && p.adapter !== 'human' && adapters?.[p.id]
  );

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
    try {
      const result = await adapters[synthesisParticipant.id].speak(ctx);
      if (result && typeof result === 'object') {
        if (typeof result.summary === 'string') {
          summary = result.summary;
        } else if (typeof result.utterance === 'string') {
          summary = result.utterance;
        }
      }
    } catch {
      summary = null;
    }
  }

  board.summary = summary;
  board.meta.status = 'ended';
  saveBoard(stateDir, board);
  emit({ type: 'ended', endedBy: board.meta.endedBy, summary: board.summary, board });
}
