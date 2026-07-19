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

    if (typeof participant.adapter !== "string" || !ADAPTER_NAMES.includes(participant.adapter)) {
      throw new Error(
        `participant "${participant.id}" has unknown adapter "${participant.adapter}" (known: ${ADAPTER_NAMES.join(", ")})`
      );
    }
  }

  const port = typeof obj.port === "number" && Number.isFinite(obj.port) ? obj.port : DEFAULT_PORT;
  const maxRounds =
    typeof obj.maxRounds === "number" && Number.isFinite(obj.maxRounds)
      ? obj.maxRounds
      : DEFAULT_MAX_ROUNDS;

  return {
    port,
    maxRounds,
    participants: /** @type {Participant[]} */ (participants),
  };
}
