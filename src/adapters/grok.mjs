// @ts-check
/**
 * Grok CLI adapter.
 * Spawns:
 *   grok --prompt-file <tmp/prompt.txt> --json-schema <inline JSON>
 *        --output-format streaming-json --system-prompt-override <persona>
 *        --cwd <tmpdir> --no-memory --disable-web-search
 *        --permission-mode <plan|bypassPermissions> --max-turns <6|10>
 * (permission mode / max turns are driven by the participant's pcAccess
 * config; see buildGrokArgs.)
 * The prompt is written to a temp file and passed via `--prompt-file`
 * (verified real flag in `grok --help`) instead of an argv literal — this
 * avoids the Windows command-line length limit for long board prompts.
 *
 * streaming-json の実形式（実CLIで1shot確認, 2026-07-20）:
 *   {"type":"thought","data":"<思考断片>"}   … reasoningのトークン断片
 *   {"type":"text","data":"<本文断片>"}      … 応答テキストのトークン断片
 *   {"type":"end","stopReason":"EndTurn",...,"structuredOutput":{...}}
 * 最終行の end イベントが structuredOutput（--json-schema準拠）を運ぶ。
 * 進捗: thought/text の data 断片を ctx.onProgress へ流す。
 * 最終結果: end.structuredOutput を優先、無ければ text断片の連結をパース。
 * 旧 `--output-format json`（単一JSON envelope）出力もフォールバックで
 * パース可能（後方互換・テスト済み経路の非破壊）。
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
 *
 * pcAccess (config, default "read"):
 * - "read": `--permission-mode plan` (read-only tools; the AI can only look
 *   at the PC) with `--max-turns 6` to leave room for read-tool round trips.
 * - "full": `--permission-mode bypassPermissions` (read/write/execute without
 *   approval — explicit opt-in, at the user's own risk) with `--max-turns 10`.
 *
 * model (config, optional): adds `-m <model>` only when specified; omitted =
 * inherit grok's own default model.
 * effort (config, optional): adds `--reasoning-effort <level>` only when
 * specified; omitted = inherit grok's default. Passed through verbatim — an
 * invalid level is rejected by the CLI and surfaces via the adapter's
 * pass+error path.
 * @param {{promptFilePath:string, schemaJson:object, persona?:string, cwd:string, pcAccess?:"read"|"full", model?:string, effort?:string}} opts
 * @returns {string[]}
 */
export function buildGrokArgs({ promptFilePath, schemaJson, persona, cwd, pcAccess, model, effort }) {
  const full = pcAccess === "full";
  const args = [
    "--prompt-file",
    promptFilePath,
    "--json-schema",
    JSON.stringify(schemaJson ?? {}),
    "--output-format",
    "streaming-json",
    "--system-prompt-override",
    persona ?? "",
    "--cwd",
    cwd,
    "--no-memory",
    "--disable-web-search",
    "--permission-mode",
    full ? "bypassPermissions" : "plan",
    "--max-turns",
    full ? "10" : "6",
  ];
  if (model) args.push("-m", model);
  if (effort) args.push("--reasoning-effort", effort);
  return args;
}

/**
 * streaming-json の1行から進捗テキスト断片を抜き出す純関数。
 * thought（思考）/ text（本文）どちらの断片も対象。他の行・非JSON行は null。
 * @param {string} line
 * @returns {string|null}
 */
export function extractGrokProgress(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if ((obj.type === "text" || obj.type === "thought") && typeof obj.data === "string" && obj.data !== "") {
    return obj.data;
  }
  return null;
}

/**
 * Parse grok's stdout into a normalized TurnResult.
 *
 * Primary path (streaming-json): 最後の type:"end" 行の structuredOutput を採用。
 * structuredOutput が無ければ text断片（type:"text" の data）を連結してパース。
 * Fallback path (旧 --output-format json): 単一JSON envelope（structuredOutput
 * 優先・text フィールドの二次パース）。
 * @param {string} stdout
 * @returns {import('./util.mjs').TurnResult}
 */
export function parseGrokOutput(stdout) {
  // ---- streaming-json（JSONL）経路 ----
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  /** @type {any[]} */
  const parsedLines = [];
  for (const line of lines) {
    try {
      parsedLines.push(JSON.parse(line));
    } catch {
      // 非JSON行はスキップ
    }
  }
  const hasStreamEvents = parsedLines.some(
    (o) => o && typeof o === "object" && (o.type === "end" || o.type === "text" || o.type === "thought")
  );
  if (hasStreamEvents) {
    for (let i = parsedLines.length - 1; i >= 0; i--) {
      const obj = parsedLines[i];
      if (obj && typeof obj === "object" && obj.type === "end") {
        if (obj.structuredOutput && typeof obj.structuredOutput === "object") {
          return normalizeTurnResult(obj.structuredOutput);
        }
        break; // endはあるがstructuredOutputなし → text断片連結へ
      }
    }
    const joined = parsedLines
      .filter((o) => o && typeof o === "object" && o.type === "text" && typeof o.data === "string")
      .map((o) => o.data)
      .join("");
    if (joined.trim() !== "") {
      return normalizeTurnResult(parseModelJson(joined));
    }
    throw new Error("grok adapter: streaming output had no structuredOutput and no text fragments");
  }

  // ---- 旧 --output-format json（単一envelope）フォールバック ----
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
    const { participant, promptText, schemaJson, onProgress } = ctx;
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
          pcAccess: participant?.pcAccess,
          model: participant?.model,
          effort: participant?.effort,
        });
        const result = await runProcess({
          command,
          args,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          cwd,
          onStdoutLine:
            typeof onProgress === "function"
              ? (line) => {
                  const text = extractGrokProgress(line);
                  if (text) {
                    try {
                      onProgress(text);
                    } catch {
                      // onProgress内の例外は握りつぶす
                    }
                  }
                }
              : undefined,
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
