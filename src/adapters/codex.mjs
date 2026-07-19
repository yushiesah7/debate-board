// @ts-check
/**
 * Codex CLI adapter.
 * Spawns `codex exec --json --output-schema <schema.json> --skip-git-repo-check -C <tmpdir>`
 * with the prompt on stdin (stdin-first design per spec; codex exec also
 * accepts a trailing positional prompt argument, kept as a fallback note
 * below in case stdin support regresses in a future codex version).
 * Output is JSONL (one JSON object per line); the final structured message
 * is extracted from the last usable line.
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
 * `model` maps to `codex exec -m/--model <MODEL>` (verified in
 * `codex exec --help`, codex 0.144.x) and is omitted when not configured.
 *
 * pcAccess (config, default "read"):
 * - "read": adds `--sandbox read-only` — the AI can only look at the PC.
 * - "full": adds `--sandbox danger-full-access` — read/write/execute without
 *   sandboxing. Explicit opt-in, at the user's own risk.
 *
 * effort (config, optional): adds `-c model_reasoning_effort=<level>` only
 * when specified; omitted = inherit the user's codex config default. Passed
 * through verbatim — an invalid level is rejected by the CLI/backend and
 * surfaces via the adapter's pass+error path.
 * @param {{schemaFilePath:string, cwd:string, model?:string, pcAccess?:"read"|"full", effort?:string}} opts
 * @returns {string[]}
 */
export function buildCodexArgs({ schemaFilePath, cwd, model, pcAccess, effort }) {
  const args = [
    "exec",
    "--json",
    "--output-schema",
    schemaFilePath,
    "--skip-git-repo-check",
    "-C",
    cwd,
    // Disable the user's configured MCP servers for this headless run.
    // Without this, codex exec loads every configured MCP server at startup
    // and a server requiring OAuth (e.g. Cloudflare MCP) is fatal (exit 1).
    // Verified on the real CLI: `-c mcp_servers={}` -> exit 0. No shell
    // quoting needed — spawn(shell:false) passes the literal string through.
    "-c",
    "mcp_servers={}",
    "--sandbox",
    pcAccess === "full" ? "danger-full-access" : "read-only",
  ];
  if (model) args.push("-m", model);
  if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
  return args;
}

/**
 * codex exec has no --system-prompt equivalent, so the persona is prepended
 * to the stdin prompt instead. Pure + unit-testable.
 * @param {string|undefined} persona
 * @param {string} promptText
 * @returns {string}
 */
export function buildCodexInput(persona, promptText) {
  return persona ? `${persona}\n\n${promptText}` : promptText;
}

/**
 * Candidate keys, in priority order, that might hold the final structured
 * payload inside a parsed JSONL line object.
 */
const CANDIDATE_KEYS = ["structuredOutput", "output", "result", "content", "message", "text", "msg"];

/**
 * Try to coerce a single parsed JSONL line into a TurnResult. Returns null
 * if this line doesn't look like the final structured answer.
 * @param {unknown} line
 * @returns {import('./util.mjs').TurnResult|null}
 */
function tryExtractFromLine(line) {
  if (!line || typeof line !== "object" || Array.isArray(line)) return null;
  const obj = /** @type {Record<string, unknown>} */ (line);

  // The line itself may already be the turn-result object. Only treat it as
  // such if it actually carries the tell-tale "utterance" key — otherwise
  // normalizeTurnResult's lenient defaults would silently accept any JSONL
  // envelope line (e.g. {"type":"log","msg":"..."}) as an empty turn result.
  if ("utterance" in obj) {
    try {
      return normalizeTurnResult(obj);
    } catch {
      // fall through to candidate-key extraction
    }
  }

  for (const key of CANDIDATE_KEYS) {
    const val = obj[key];
    if (val == null) continue;
    if (typeof val === "object") {
      try {
        return normalizeTurnResult(val);
      } catch {
        continue;
      }
    }
    if (typeof val === "string") {
      try {
        return normalizeTurnResult(parseModelJson(val));
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Parse codex `--json` JSONL stdout into a normalized TurnResult.
 *
 * Real envelope shape (verified on codex CLI, 2026-07-20):
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"<body>"}}
 *   {"type":"turn.completed","usage":{...}}
 *
 * Primary path: take the LAST `item.completed` line whose `item.type` is
 * `agent_message` and JSON-parse `item.text` (with --output-schema this is a
 * schema-conforming JSON string; fence-stripping handled by parseModelJson).
 * Failure path: codex exec can exit 0 even when the turn failed; when no
 * agent_message exists but an `error` / `turn.failed` event does, its message
 * is thrown so the retry/failResult chain records the true root cause.
 * Fallback: scan lines from the end for any other usable structured payload
 * (candidate-key heuristics), in case the envelope shape changes.
 * @param {string} stdout
 * @returns {import('./util.mjs').TurnResult}
 */
export function parseCodexOutput(stdout) {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error("codex adapter: empty output");

  /** @type {unknown[]} */
  const parsedLines = [];
  for (const line of lines) {
    try {
      parsedLines.push(JSON.parse(line));
    } catch {
      // skip non-JSON noise lines
    }
  }

  // Primary: last item.completed / agent_message line.
  for (let i = parsedLines.length - 1; i >= 0; i--) {
    const obj = /** @type {any} */ (parsedLines[i]);
    if (
      obj &&
      typeof obj === "object" &&
      obj.type === "item.completed" &&
      obj.item &&
      typeof obj.item === "object" &&
      obj.item.type === "agent_message" &&
      typeof obj.item.text === "string"
    ) {
      return normalizeTurnResult(parseModelJson(obj.item.text));
    }
  }

  // No agent_message found. If the stream carries an explicit failure event,
  // surface its message as the root cause. IMPORTANT: codex exec can exit 0
  // even when the turn failed (e.g. backend 400 rejecting --output-schema),
  // so exit-code checks alone are not sufficient.
  for (let i = parsedLines.length - 1; i >= 0; i--) {
    const obj = /** @type {any} */ (parsedLines[i]);
    if (obj && typeof obj === "object" && (obj.type === "error" || obj.type === "turn.failed")) {
      const detail =
        typeof obj.message === "string"
          ? obj.message
          : typeof obj?.error?.message === "string"
            ? obj.error.message
            : JSON.stringify(obj);
      throw new Error(`codex adapter: ${obj.type}: ${detail}`);
    }
  }

  // Fallback: generic candidate-key extraction, newest line first.
  for (let i = parsedLines.length - 1; i >= 0; i--) {
    const extracted = tryExtractFromLine(parsedLines[i]);
    if (extracted) return extracted;
  }
  throw new Error("codex adapter: no structured payload found in JSONL output");
}

/**
 * @param {import('../engine.mjs').SpeakCtx} ctx
 * @returns {Promise<import('./util.mjs').TurnResult>}
 */
export async function speak(ctx) {
  try {
    const { participant, promptText, schemaJson } = ctx;
    const command = resolveCommand("codex");

    return await runWithRetry(async () => {
      const cwd = makeTempDir("debate-board-codex-");
      try {
        const schemaFilePath = path.join(cwd, "output-schema.json");
        fs.writeFileSync(schemaFilePath, JSON.stringify(schemaJson ?? {}, null, 2), "utf8");

        const args = buildCodexArgs({
          schemaFilePath,
          cwd,
          model: participant?.model,
          pcAccess: participant?.pcAccess,
          effort: participant?.effort,
        });
        const result = await runProcess({
          command,
          args,
          input: buildCodexInput(participant?.persona, promptText),
          timeoutMs: DEFAULT_TIMEOUT_MS,
          cwd,
        });
        if (result.spawnError) throw result.spawnError;
        if (result.timedOut) throw new Error("codex adapter: timed out");
        if (result.code !== 0) {
          throw new Error(
            `codex adapter: exited with code ${result.code}: ${result.stderr.slice(0, 500)}`
          );
        }
        return parseCodexOutput(result.stdout);
      } finally {
        removeDirQuietly(cwd);
      }
    }, 1);
  } catch (err) {
    // Belt and braces: no code path may throw out of an adapter.
    return failResult(err);
  }
}
