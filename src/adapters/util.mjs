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

/** Hard cap on captured stdout+stderr (each), to bound memory. */
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Grace period after a kill before force-resolving the promise. */
const KILL_GRACE_MS = 2500;

/**
 * Kill a child process and its whole tree. On Windows, `child.kill()` only
 * signals the direct child (CLI shims often spawn a node subprocess that
 * survives), so use `taskkill /T /F`. Elsewhere SIGTERM then SIGKILL.
 * @param {import('node:child_process').ChildProcess} child
 * @param {(fn:() => void, ms:number) => void} addTimer
 */
function killTree(child, addTimer) {
  if (process.platform === "win32" && child.pid) {
    try {
      const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
      });
      tk.on("error", () => {});
    } catch {
      // fall back to plain kill below
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  addTimer(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 2000);
}

/**
 * Run a child process (shell:false, argv array) with a hard timeout, feeding
 * `input` to stdin. Never rejects — always resolves with a result descriptor,
 * even if the child ignores kill signals (a grace timer force-resolves).
 * Captured output is capped at MAX_OUTPUT_BYTES per stream; exceeding the cap
 * kills the process tree and surfaces an error.
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
    /** @type {Set<NodeJS.Timeout>} */
    const timers = new Set();
    const addTimer = (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      timers.add(t);
      return t;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      resolve(result);
    };

    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(command, args, { shell: false, cwd, windowsHide: true });
    } catch (err) {
      finish({
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
    /** @type {Error|null} */
    let outputError = null;

    addTimer(() => {
      timedOut = true;
      killTree(child, addTimer);
      // Guarantee resolution even if 'close' never fires after the kill.
      addTimer(
        () => finish({ code: null, stdout, stderr, timedOut: true, spawnError: outputError }),
        KILL_GRACE_MS
      );
    }, timeoutMs);

    const capAppend = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (next.length > MAX_OUTPUT_BYTES) {
        if (!outputError) {
          outputError = new Error(
            `process output exceeded ${MAX_OUTPUT_BYTES} bytes; killed`
          );
          killTree(child, addTimer);
          addTimer(
            () => finish({ code: null, stdout, stderr, timedOut, spawnError: outputError }),
            KILL_GRACE_MS
          );
        }
        return next.slice(0, MAX_OUTPUT_BYTES);
      }
      return next;
    };

    child.on("error", (err) => {
      finish({ code: null, stdout, stderr, timedOut, spawnError: err });
    });
    // Swallow stream errors (a dying child can EPIPE its pipes; an unhandled
    // 'error' on any of these streams would crash the whole process).
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    child.stdout?.on("data", (d) => {
      stdout = capAppend(stdout, d);
    });
    child.stderr?.on("data", (d) => {
      stderr = capAppend(stderr, d);
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut, spawnError: outputError });
    });

    if (child.stdin) {
      try {
        if (input != null) child.stdin.write(input, "utf8");
        child.stdin.end();
      } catch {
        // stdin may already be closed (fast-exiting child); 'error' handler
        // above covers async EPIPE, this covers the sync throw path.
      }
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

/**
 * Best-effort recursive removal of a temp dir; never throws.
 * @param {string|null|undefined} dir
 */
export function removeDirQuietly(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort only
  }
}

/**
 * Normalize an HTTP endpoint: strip trailing slashes so path concatenation
 * (`${endpoint}/api/chat`) never produces `//`.
 * @param {unknown} endpoint
 * @returns {string}
 */
export function normalizeEndpoint(endpoint) {
  return String(endpoint ?? "").replace(/\/+$/, "");
}

/**
 * POST JSON to `url` and parse the response body as JSON via res.text() so
 * that a non-JSON body produces a diagnosable error (first 200 chars
 * included) instead of an opaque fetch .json() failure. Throws on HTTP
 * error status or unparsable body — callers wrap in runWithRetry.
 * @param {string} url
 * @param {object} body
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
export async function fetchJson(url, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`response was not valid JSON: ${text.slice(0, 200)}`);
  }
}
