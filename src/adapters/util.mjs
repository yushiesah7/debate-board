// @ts-check
/**
 * Shared low-level utilities for CLI/HTTP adapters.
 * Zero dependencies: only node:child_process, node:fs, node:path, node:http, fetch.
 *
 * @typedef {object} TurnResult
 * @property {string} utterance
 * @property {Array<object>} cardOps
 * @property {string|null} noteUpdate
 * @property {boolean} pass
 * @property {string|null} error
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Build a normalized, always-safe TurnResult for failure cases.
 * Per spec: parse/process failures must never throw — they resolve as
 * `{utterance:"", cardOps:[], noteUpdate:null, pass:true, error}`.
 * @param {unknown} err
 * @returns {TurnResult}
 */
export function failResult(err) {
  const message =
    err && typeof err === "object" && "message" in err
      ? String(/** @type {{message:unknown}} */ (err).message)
      : String(err);
  return {
    utterance: "",
    cardOps: [],
    noteUpdate: null,
    pass: true,
    error: message,
  };
}

/**
 * Normalize an arbitrary parsed JSON value into a strict TurnResult shape.
 * Throws if the input is not a plausible turn-result object (caller should
 * catch and convert via failResult).
 * @param {unknown} parsed
 * @returns {TurnResult}
 */
export function normalizeTurnResult(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid turn result: response is not a JSON object");
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  const utterance = typeof obj.utterance === "string" ? obj.utterance : "";
  const cardOps = Array.isArray(obj.cardOps) ? obj.cardOps : [];
  const noteUpdate = typeof obj.noteUpdate === "string" ? obj.noteUpdate : null;
  const pass = typeof obj.pass === "boolean" ? obj.pass : false;
  return { utterance, cardOps, noteUpdate, pass, error: null };
}

/**
 * Strip a ```json ... ``` or ``` ... ``` fence wrapping the whole text, if present.
 * @param {string} text
 * @returns {string}
 */
export function stripCodeFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

/**
 * Parse a model response body into JSON, tolerating a wrapping code fence
 * and leading/trailing prose around a single JSON object.
 * @param {unknown} text
 * @returns {unknown}
 */
export function parseModelJson(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("no text to parse as JSON");
  }
  const unfenced = stripCodeFence(text);
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(unfenced.slice(start, end + 1));
    }
    throw new Error("could not locate a JSON object in model response");
  }
}

/**
 * Resolve a bare command name to an executable path, working around
 * Windows' refusal to resolve PATHEXT-suffixed shims (.cmd/.bat) via
 * spawn({shell:false}). On non-Windows platforms this is a no-op.
 * @param {string} command
 * @returns {string}
 */
export function resolveCommand(command) {
  if (process.platform !== "win32") return command;
  if (/[\\/]/.test(command)) return command; // already a path
  const pathExts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const dirs = (process.env.PATH || process.env.Path || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of dirs) {
    // Exact name first (e.g. already has an extension, or is extension-less).
    const bare = path.join(dir, command);
    if (existsAsFile(bare)) return bare;
    for (const ext of pathExts) {
      const candidate = path.join(dir, command + ext);
      if (existsAsFile(candidate)) return candidate;
    }
  }
  return command; // fall through; spawn will raise ENOENT naturally
}

/** @param {string} p */
function existsAsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * @typedef {object} ProcessRunResult
 * @property {number|null} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {Error|null} spawnError
 */

/**
 * Run a child process (shell:false, argv array) with a hard timeout, feeding
 * `input` to stdin. Never rejects — always resolves with a result descriptor.
 * @param {{command:string, args?:string[], input?:string, timeoutMs?:number, cwd?:string}} opts
 * @returns {Promise<ProcessRunResult>}
 */
export function runProcess({
  command,
  args = [],
  input,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd,
}) {
  return new Promise((resolve) => {
    let settled = false;
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(command, args, { shell: false, cwd, windowsHide: true });
    } catch (err) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: /** @type {Error} */ (err),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (err) => {
      finish({ code: null, stdout, stderr, timedOut, spawnError: err });
    });
    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut, spawnError: null });
    });

    if (child.stdin) {
      if (input != null) child.stdin.write(input, "utf8");
      child.stdin.end();
    }
  });
}

/**
 * Run `attempt()` and, on any thrown error, retry once more before falling
 * back to a normalized failResult. `attempt` must resolve to a TurnResult
 * on success and throw on any failure (spawn error / timeout / bad exit /
 * parse failure).
 * @param {() => Promise<TurnResult>} attempt
 * @param {number} retries
 * @returns {Promise<TurnResult>}
 */
export async function runWithRetry(attempt, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
    }
  }
  return failResult(lastErr);
}

/**
 * fetch() with an AbortController-based timeout. Rejects (does not swallow)
 * on timeout/network error — callers wrap this in runWithRetry.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 */
export async function fetchWithTimeout(url, init, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a fresh temp directory under os.tmpdir() for CLI adapters that
 * require an isolated --cwd (codex, grok).
 * @param {string} prefix
 * @returns {string}
 */
export function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
