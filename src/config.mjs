// @ts-check
/**
 * config.json loader/validator. `config.json` is the user's local, uncommitted
 * config (git-ignored per repo policy); `config.example.json` is the
 * committed fallback/template shipped in the repo.
 *
 * @typedef {object} Participant
 * @property {string} id
 * @property {string} name
 * @property {string} adapter
 * @property {string} [model]
 * @property {string} [endpoint]
 * @property {string} [persona]
 * @property {boolean} enabled
 * @property {"read"|"full"} pcAccess
 *   How much of the user's PC the participant's AI may touch during a debate.
 *   "read" (default) = look-only; "full" = read/write/execute — an explicit,
 *   at-your-own-risk opt-in. Only meaningful for CLI adapters (claude/codex/
 *   grok); ollama, openai-compat and human have no PC access at all, so the
 *   value is accepted but ignored for them.
 * @property {string} [effort]
 *   Reasoning-effort level, passed through to the CLI verbatim
 *   (claude `--effort`, codex `-c model_reasoning_effort=`, grok
 *   `--reasoning-effort`). Validation here only requires a non-empty string
 *   when present — the set of valid levels differs per CLI, so the value is
 *   NOT checked against a whitelist; if a CLI rejects it, the failure
 *   surfaces through the adapter's normal pass+error path. Omitted =
 *   inherit each CLI's own default. Ignored by ollama/openai-compat/human.
 *
 * @typedef {object} Config
 * @property {number} port
 * @property {number} maxRounds
 * @property {string} autoExportDir
 *   議論終了時にrules/notesのJSONを自動保存するディレクトリ（既定 "exports"）。
 *   相対パスは利用側（server/cli）がリポルート基準に解決する。git管理外。
 * @property {Participant[]} participants
 */

import fs from "node:fs";
import path from "node:path";

import { ADAPTER_NAMES } from "./adapters/index.mjs";

export const DEFAULT_PORT = 8787;
export const DEFAULT_MAX_ROUNDS = 4;
export const PC_ACCESS_VALUES = ["read", "full"];
export const DEFAULT_PC_ACCESS = "read";
export const DEFAULT_AUTO_EXPORT_DIR = "exports";

/**
 * Load and validate config from `<rootDir>/config.json`, falling back to
 * `<rootDir>/config.example.json` if the local config doesn't exist.
 * @param {string} rootDir
 * @returns {Config}
 */
export function loadConfig(rootDir) {
  const configPath = path.join(rootDir, "config.json");
  const examplePath = path.join(rootDir, "config.example.json");

  const sourcePath = fs.existsSync(configPath) ? configPath : examplePath;
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `no config found: neither ${configPath} nor ${examplePath} exist`
    );
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  } catch (err) {
    throw new Error(`failed to parse ${sourcePath} as JSON: ${err.message}`);
  }

  return validateConfig(raw);
}

/**
 * Validate a raw parsed config object and fill in defaults. Throws on any
 * structural problem (empty participants, duplicate ids, unknown adapter).
 * @param {unknown} raw
 * @returns {Config}
 */
export function validateConfig(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("config must be a JSON object");
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);

  const participants = obj.participants;
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new Error("config.participants must be a non-empty array");
  }

  const seenIds = new Set();
  let humanCount = 0;
  /** @type {Participant[]} */
  const normalized = [];
  for (const p of participants) {
    if (!p || typeof p !== "object") {
      throw new Error("each participant must be an object");
    }
    const participant = /** @type {Record<string, unknown>} */ (p);
    if (typeof participant.id !== "string" || participant.id === "") {
      throw new Error("each participant must have a non-empty string id");
    }
    if (seenIds.has(participant.id)) {
      throw new Error(`duplicate participant id: ${participant.id}`);
    }
    seenIds.add(participant.id);

    if (typeof participant.name !== "string" || participant.name === "") {
      throw new Error(`participant "${participant.id}" must have a non-empty string name`);
    }

    if (typeof participant.adapter !== "string" || !ADAPTER_NAMES.includes(participant.adapter)) {
      throw new Error(
        `participant "${participant.id}" has unknown adapter "${participant.adapter}" (known: ${ADAPTER_NAMES.join(", ")})`
      );
    }

    // HTTP adapters require a non-empty, parseable endpoint URL.
    if (participant.adapter === "ollama" || participant.adapter === "openai-compat") {
      if (typeof participant.endpoint !== "string" || participant.endpoint.trim() === "") {
        throw new Error(
          `participant "${participant.id}" (adapter ${participant.adapter}) requires a non-empty endpoint URL`
        );
      }
      try {
        new URL(participant.endpoint);
      } catch {
        throw new Error(
          `participant "${participant.id}" has an invalid endpoint URL: ${participant.endpoint}`
        );
      }
    }

    if (participant.adapter === "human") {
      humanCount++;
      if (humanCount > 1) {
        throw new Error("config allows at most one human participant");
      }
    }

    // pcAccess: default "read"; if present it must be one of PC_ACCESS_VALUES.
    // (Ignored at runtime by ollama/openai-compat/human, but still validated
    // so typos never silently grant or deny access.)
    let pcAccess = DEFAULT_PC_ACCESS;
    if (participant.pcAccess !== undefined) {
      if (
        typeof participant.pcAccess !== "string" ||
        !PC_ACCESS_VALUES.includes(participant.pcAccess)
      ) {
        throw new Error(
          `participant "${participant.id}" pcAccess must be one of ${PC_ACCESS_VALUES.join("|")} (got ${JSON.stringify(participant.pcAccess)})`
        );
      }
      pcAccess = participant.pcAccess;
    }

    // effort: optional; when present it must be a non-empty string. Values
    // are passed through to the CLI as-is (per-CLI level sets differ; an
    // invalid level is surfaced by the CLI via the pass+error path).
    if (participant.effort !== undefined) {
      if (typeof participant.effort !== "string" || participant.effort.trim() === "") {
        throw new Error(
          `participant "${participant.id}" effort must be a non-empty string when specified (got ${JSON.stringify(participant.effort)})`
        );
      }
    }

    // enabled: default true; if present it must be a real boolean.
    let enabled;
    if (participant.enabled === undefined) {
      enabled = true;
    } else if (typeof participant.enabled === "boolean") {
      enabled = participant.enabled;
    } else {
      throw new Error(
        `participant "${participant.id}" enabled must be a boolean (got ${typeof participant.enabled})`
      );
    }

    normalized.push(/** @type {Participant} */ ({ ...participant, enabled, pcAccess }));
  }

  let port = DEFAULT_PORT;
  if (obj.port !== undefined) {
    const v = obj.port;
    if (!Number.isInteger(v) || /** @type {number} */ (v) < 1 || /** @type {number} */ (v) > 65535) {
      throw new Error(`config.port must be an integer in 1..65535 (got ${v})`);
    }
    port = /** @type {number} */ (v);
  }

  let maxRounds = DEFAULT_MAX_ROUNDS;
  if (obj.maxRounds !== undefined) {
    const v = obj.maxRounds;
    if (!Number.isInteger(v) || /** @type {number} */ (v) < 1) {
      throw new Error(`config.maxRounds must be an integer >= 1 (got ${v})`);
    }
    maxRounds = /** @type {number} */ (v);
  }

  // autoExportDir: 既定 "exports"。指定時は非空文字列であること。
  let autoExportDir = DEFAULT_AUTO_EXPORT_DIR;
  if (obj.autoExportDir !== undefined) {
    if (typeof obj.autoExportDir !== "string" || obj.autoExportDir.trim() === "") {
      throw new Error(
        `config.autoExportDir must be a non-empty string when specified (got ${JSON.stringify(obj.autoExportDir)})`
      );
    }
    autoExportDir = obj.autoExportDir;
  }

  return { port, maxRounds, autoExportDir, participants: normalized };
}
