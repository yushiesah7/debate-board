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
 * @param {{model?:string, persona?:string, pcAccess?:"read"|"full"}} participant
 * @returns {string[]}
 */
export function buildClaudeArgs(participant) {
  const model = participant?.model ?? "";
  const persona = participant?.persona ?? "";
  const args = ["-p", "--output-format", "json", "--model", model, "--system-prompt", persona];
  if (participant?.pcAccess === "full") {
    args.push("--permission-mode", "bypassPermissions");
  }
  return args;
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
  try {
    const { participant, promptText } = ctx;
    const command = resolveCommand("claude");
    const args = buildClaudeArgs(participant);

    return await runWithRetry(async () => {
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
  } catch (err) {
    // Belt and braces: no code path may throw out of an adapter.
    return failResult(err);
  }
}
