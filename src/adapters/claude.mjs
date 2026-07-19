// @ts-check
/**
 * Claude CLI adapter.
 * Spawns `claude -p --output-format json --model <model> --system-prompt <persona>`
 * with the prompt delivered over stdin. The CLI's JSON envelope carries the
 * actual model text in a `result` field (possibly fenced), which we parse a
 * second time into the common TurnResult shape.
 */

import {
  resolveCommand,
  runProcess,
  runWithRetry,
  parseModelJson,
  normalizeTurnResult,
  DEFAULT_TIMEOUT_MS,
} from "./util.mjs";

/**
 * Pure argv builder — unit-testable without spawning anything.
 * @param {{model?:string, persona?:string}} participant
 * @returns {string[]}
 */
export function buildClaudeArgs(participant) {
  const model = participant?.model ?? "";
  const persona = participant?.persona ?? "";
  return ["-p", "--output-format", "json", "--model", model, "--system-prompt", persona];
}

/**
 * Parse the claude CLI's stdout into a normalized TurnResult.
 * Throws on any structural problem; caller converts to failResult.
 * @param {string} stdout
 * @returns {import('./util.mjs').TurnResult}
 */
export function parseClaudeOutput(stdout) {
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
  const { participant, promptText } = ctx;
  const command = resolveCommand("claude");
  const args = buildClaudeArgs(participant);

  return runWithRetry(async () => {
    const result = await runProcess({
      command,
      args,
      input: promptText,
      timeoutMs: DEFAULT_TIMEOUT_MS,
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
}
