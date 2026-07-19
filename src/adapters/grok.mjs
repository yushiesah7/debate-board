// @ts-check
/**
 * Grok CLI adapter.
 * Spawns:
 *   grok --prompt-file <tmp/prompt.txt> --json-schema <inline JSON>
 *        --output-format json --system-prompt-override <persona>
 *        --cwd <tmpdir> --no-memory --disable-web-search
 *        --permission-mode dontAsk --max-turns 3
 * The prompt is written to a temp file and passed via `--prompt-file`
 * (verified real flag in `grok --help`) instead of an argv literal — this
 * avoids the Windows command-line length limit for long board prompts.
 * The response is a single JSON object; `structuredOutput` is preferred,
 * falling back to parsing the free-form `text` field.
 */

import fs from "node:fs";
import path from "node:path";

import {
  resolveCommand,
  runProcess,
  runWithRetry,
  parseModelJson,
  normalizeTurnResult,
  makeTempDir,
  removeDirQuietly,
  failResult,
  DEFAULT_TIMEOUT_MS,
} from "./util.mjs";

/**
 * Pure argv builder — unit-testable without spawning anything.
 * @param {{promptFilePath:string, schemaJson:object, persona?:string, cwd:string}} opts
 * @returns {string[]}
 */
export function buildGrokArgs({ promptFilePath, schemaJson, persona, cwd }) {
  return [
    "--prompt-file",
    promptFilePath,
    "--json-schema",
    JSON.stringify(schemaJson ?? {}),
    "--output-format",
    "json",
    "--system-prompt-override",
    persona ?? "",
    "--cwd",
    cwd,
    "--no-memory",
    "--disable-web-search",
    "--permission-mode",
    "dontAsk",
    "--max-turns",
    "3",
  ];
}

/**
 * Parse grok's `--output-format json` stdout into a normalized TurnResult.
 * @param {string} stdout
 * @returns {import('./util.mjs').TurnResult}
 */
export function parseGrokOutput(stdout) {
  const envelope = parseModelJson(stdout);
  if (envelope && typeof envelope === "object") {
    const obj = /** @type {Record<string, unknown>} */ (envelope);
    if (obj.structuredOutput && typeof obj.structuredOutput === "object") {
      return normalizeTurnResult(obj.structuredOutput);
    }
    if (typeof obj.text === "string") {
      return normalizeTurnResult(parseModelJson(obj.text));
    }
  }
  // Envelope might already be the turn result itself.
  return normalizeTurnResult(envelope);
}

/**
 * @param {import('../engine.mjs').SpeakCtx} ctx
 * @returns {Promise<import('./util.mjs').TurnResult>}
 */
export async function speak(ctx) {
  try {
    const { participant, promptText, schemaJson } = ctx;
    const command = resolveCommand("grok");

    return await runWithRetry(async () => {
      const cwd = makeTempDir("debate-board-grok-");
      try {
        const promptFilePath = path.join(cwd, "prompt.txt");
        fs.writeFileSync(promptFilePath, promptText, "utf8");
        const args = buildGrokArgs({
          promptFilePath,
          schemaJson,
          persona: participant?.persona,
          cwd,
        });
        const result = await runProcess({
          command,
          args,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          cwd,
        });
        if (result.spawnError) throw result.spawnError;
        if (result.timedOut) throw new Error("grok adapter: timed out");
        if (result.code !== 0) {
          throw new Error(
            `grok adapter: exited with code ${result.code}: ${result.stderr.slice(0, 500)}`
          );
        }
        return parseGrokOutput(result.stdout);
      } finally {
        removeDirQuietly(cwd);
      }
    }, 1);
  } catch (err) {
    // Belt and braces: no code path may throw out of an adapter.
    return failResult(err);
  }
}
