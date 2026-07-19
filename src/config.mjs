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
 *
 * @typedef {object} Config
 * @property {number} port
 * @property {number} maxRounds
 * @property {Participant[]} participants
 */

import fs from "node:fs";
import path from "node:path";

import { ADAPTER_NAMES } from "./adapters/index.mjs";

export const DEFAULT_PORT = 8787;
export const DEFAULT_MAX_ROUNDS = 4;

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

    normalized.push(/** @type {Participant} */ ({ ...participant, enabled }));
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

  return { port, maxRounds, participants: normalized };
}
