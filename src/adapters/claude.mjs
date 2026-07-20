// @ts-check
/**
 * Claude CLI adapter.
 * Spawns `claude -p --output-format stream-json --verbose --model <model>
 * --system-prompt <persona>` with the prompt delivered over stdin.
 *
 * stream-json の実形式（実CLI claude 2.1.215 で1shot確認, 2026-07-20）:
 *   {"type":"system","subtype":"init",...}                        … 起動情報等（無視）
 *   {"type":"assistant","message":{"content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"<本文>"}]}}
 *   {"type":"result","subtype":"success","is_error":false,"result":"<最終テキスト>",...}
 * ※ stream-json は --print 時に --verbose 必須（CLIヘルプ「only works with --print and
 *   --output-format=stream-json」の各種フラグ説明と実挙動で確認）。
 *
 * 進捗: type:"assistant" 行の content[].type==="text" の断片を ctx.onProgress へ流す
 * （thinkingブロックは長大・署名付きのため流さない）。
 * 最終結果: 最後の type:"result" 行の result 文字列（fenceありうる）を従来どおり
 * TurnResult へ二次パースする。旧 `--output-format json`（単一JSON envelope）出力も
 * フォールバックでパース可能（後方互換・テスト済み経路の非破壊）。
 */

import {
  resolveCommand,
  runProcess,
  runWithRetry,
  parseModelJson,
  normalizeTurnResult,
  failResult,
  DEFAULT_TIMEOUT_MS,
} from "./util.mjs";

/**
 * Pure argv builder — unit-testable without spawning anything.
 *
 * pcAccess (config, default "read"):
 * - "read": no extra flags. `claude -p` by default allows read-style tools
 *   but write/execute tools cannot be approved headlessly, so the AI can
 *   only look at the PC.
 * - "full": adds `--permission-mode bypassPermissions` — read/write/execute
 *   without approval. Explicit opt-in, at the user's own risk.
 *
 * effort (config, optional): adds `--effort <level>` only when specified;
 * omitted = inherit the CLI's own default. The value is passed through
 * verbatim — an invalid level is rejected by the CLI itself and surfaces
 * via the adapter's pass+error path.
 * @param {{model?:string, persona?:string, pcAccess?:"read"|"full", effort?:string}} participant
 * @returns {string[]}
 */
export function buildClaudeArgs(participant) {
  const model = participant?.model ?? "";
  const persona = participant?.persona ?? "";
  // stream-json: 逐次進捗（onProgress）用。--print では --verbose が必須
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--system-prompt",
    persona,
  ];
  if (participant?.effort) {
    args.push("--effort", participant.effort);
  }
  if (participant?.pcAccess === "full") {
    args.push("--permission-mode", "bypassPermissions");
  }
  return args;
}

/**
 * stream-json の1行から進捗テキスト断片を抜き出す純関数。
 * type:"assistant" 行の content[] の text ブロックだけを連結して返す。
 * 進捗を含まない行（system/result/thinking等）や非JSON行は null。
 * @param {string} line
 * @returns {string|null}
 */
export function extractClaudeProgress(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || obj.type !== "assistant") return null;
  const content = obj.message?.content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text);
  if (texts.length === 0) return null;
  return texts.join("");
}

/**
 * Parse the claude CLI's stdout into a normalized TurnResult.
 *
 * Primary path (stream-json): JSONL中の最後の type:"result" 行を採用。
 * is_error:true なら失敗としてthrow（リトライ/failResult経路に乗せる）。
 * Fallback path (旧 --output-format json): 単一JSON envelope の result フィールド。
 * Throws on any structural problem; caller converts to failResult.
 * @param {string} stdout
 * @returns {import('./util.mjs').TurnResult}
 */
export function parseClaudeOutput(stdout) {
  // ---- stream-json（JSONL）経路 ----
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  /** @type {any} */
  let resultLine = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (obj && typeof obj === "object" && obj.type === "result") {
      resultLine = obj;
      break;
    }
  }
  if (resultLine) {
    if (resultLine.is_error) {
      const detail =
        typeof resultLine.result === "string" ? resultLine.result : JSON.stringify(resultLine);
      throw new Error(`claude adapter: result error: ${detail.slice(0, 500)}`);
    }
    if (typeof resultLine.result !== "string") {
      throw new Error("claude adapter: result event has no result text");
    }
    return normalizeTurnResult(parseModelJson(resultLine.result));
  }

  // ---- 旧 --output-format json（単一envelope）フォールバック ----
  const envelope = parseModelJson(stdout);
  let bodyText = null;
  if (envelope && typeof envelope === "object" && typeof (/** @type {any} */ (envelope).result) === "string") {
    bodyText = /** @type {any} */ (envelope).result;
  } else if (typeof envelope === "string") {
    bodyText = envelope;
  }
  const parsed = bodyText != null ? parseModelJson(bodyText) : envelope;
  return normalizeTurnResult(parsed);
}

/**
 * @param {import('../engine.mjs').SpeakCtx} ctx
 * @returns {Promise<import('./util.mjs').TurnResult>}
 */
export async function speak(ctx) {
  try {
    const { participant, promptText, onProgress } = ctx;
    const command = resolveCommand("claude");
    const args = buildClaudeArgs(participant);

    return await runWithRetry(async () => {
      const result = await runProcess({
        command,
        args,
        input: promptText,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        onStdoutLine:
          typeof onProgress === "function"
            ? (line) => {
                const text = extractClaudeProgress(line);
                if (text) {
                  try {
                    onProgress(text);
                  } catch {
                    // onProgress内の例外は握りつぶす（進捗表示は本処理を壊さない）
                  }
                }
              }
            : undefined,
      });
      if (result.spawnError) throw result.spawnError;
      if (result.timedOut) throw new Error("claude adapter: timed out");
      if (result.code !== 0) {
        throw new Error(
          `claude adapter: exited with code ${result.code}: ${result.stderr.slice(0, 500)}`
        );
      }
      return parseClaudeOutput(result.stdout);
    }, 1);
  } catch (err) {
    // Belt and braces: no code path may throw out of an adapter.
    return failResult(err);
  }
}
