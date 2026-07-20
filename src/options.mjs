// @ts-check
/**
 * options.mjs — 参加者設定UI向けの model/effort 候補の自動発見（GET /api/options の中身）。
 *
 * 発見ロジック（アダプタごと・失敗したものは静的フォールバックへ。**絶対にthrowしない**）:
 * - claude: 一覧コマンドが無いため常に静的候補
 * - codex: ~/.codex/models_cache.json を読み models[].slug を抽出
 * - grok: `grok models` を実行し "Available models:" 以降の "* モデル名" 行を抽出
 * - ollama: config の ollama 参加者の endpoint から GET /api/tags → models[].name
 * - openai-compat: 同様に GET /v1/models → data[].id
 *
 * 静的フォールバック値は汎用名のみ（ユーザー固有のモデル名はコミット物に埋めない）。
 * パース部分は純関数として export し、フィクスチャでユニットテストできるようにしてある。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runProcess, resolveCommand, fetchWithTimeout, normalizeEndpoint } from "./adapters/util.mjs";

/** `grok models` の実行タイムアウト。 */
export const GROK_LIST_TIMEOUT_MS = 15_000;
/** ollama / openai-compat のモデル一覧HTTP取得タイムアウト。 */
export const HTTP_LIST_TIMEOUT_MS = 5_000;

/**
 * 静的フォールバック候補（発見失敗時・一覧手段が無いアダプタ用）。
 * @type {Record<string, {models: string[], efforts: string[]}>}
 */
export const STATIC_OPTIONS = {
  claude: { models: ["sonnet", "opus", "haiku"], efforts: ["low", "medium", "high", "xhigh"] },
  codex: { models: ["gpt-5.6-luna"], efforts: ["minimal", "low", "medium", "high", "xhigh"] },
  grok: { models: ["grok-4.5"], efforts: ["low", "medium", "high"] },
  ollama: { models: [], efforts: [] },
  "openai-compat": { models: [], efforts: [] },
};

/** @returns {{adapters: Record<string, {models: string[], efforts: string[]}>}} 静的候補のディープコピー */
export function staticOptionsResponse() {
  /** @type {Record<string, {models: string[], efforts: string[]}>} */
  const adapters = {};
  for (const [name, opt] of Object.entries(STATIC_OPTIONS)) {
    adapters[name] = { models: [...opt.models], efforts: [...opt.efforts] };
  }
  return { adapters };
}

/**
 * codex の ~/.codex/models_cache.json の中身から models[].slug を抽出する純関数。
 * 実測済みの形: `{models:[{slug,display_name,...}]}`。
 * 形が不正なら throw する（呼び出し側が静的フォールバックへ落とす）。
 * @param {string} text - ファイル内容（JSON文字列）
 * @returns {string[]}
 */
export function parseCodexModelsCache(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(/** @type {any} */ (parsed).models)) {
    throw new Error("models_cache.json: models array not found");
  }
  const slugs = [];
  for (const m of /** @type {any} */ (parsed).models) {
    if (m && typeof m === "object" && typeof m.slug === "string" && m.slug !== "") {
      slugs.push(m.slug);
    }
  }
  return slugs;
}

/**
 * `grok models` の stdout からモデル名一覧を抽出する純関数。
 * 想定形式:
 *   Available models:
 *     * grok-4.5 (default)
 *     * grok-4
 * "Available models:" 以降の行のみ対象。`* 名前` の名前部分だけを取り、
 * `(default)` 等の後続注記は捨てる。1件も見つからなければ空配列を返す。
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseGrokModelsOutput(stdout) {
  const text = typeof stdout === "string" ? stdout : "";
  const markerIdx = text.indexOf("Available models:");
  const tail = markerIdx === -1 ? "" : text.slice(markerIdx + "Available models:".length);
  const models = [];
  const re = /^\s*\*\s*([^\s*][^\s]*)/gm;
  let m;
  while ((m = re.exec(tail)) !== null) {
    models.push(m[1]);
  }
  return models;
}

/**
 * ollama の GET /api/tags 応答から models[].name を抽出する純関数。
 * @param {unknown} json
 * @returns {string[]}
 */
export function parseOllamaTags(json) {
  const models = /** @type {any} */ (json)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((m) => (m && typeof m === "object" && typeof m.name === "string" ? m.name : null))
    .filter((n) => typeof n === "string" && n !== "");
}

/**
 * openai-compat の GET /v1/models 応答から data[].id を抽出する純関数。
 * @param {unknown} json
 * @returns {string[]}
 */
export function parseOpenAiModels(json) {
  const data = /** @type {any} */ (json)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m && typeof m === "object" && typeof m.id === "string" ? m.id : null))
    .filter((n) => typeof n === "string" && n !== "");
}

/**
 * GET {endpoint}{pathname} を叩いてJSONを返す。失敗時は null（throwしない）。
 * @param {(url: string, init: object, timeoutMs: number) => Promise<Response>} fetchImpl
 * @param {string} endpoint
 * @param {string} pathname
 * @returns {Promise<unknown|null>}
 */
async function tryFetchJson(fetchImpl, endpoint, pathname) {
  try {
    const url = `${normalizeEndpoint(endpoint)}${pathname}`;
    const res = await fetchImpl(url, { method: "GET" }, HTTP_LIST_TIMEOUT_MS);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 実環境から各アダプタの model/effort 候補を収集する。
 * どのアダプタで失敗しても静的フォールバックに落ち、この関数自体は絶対にthrowしない。
 *
 * 依存はすべて注入可能（テスト用）。省略時は実物を使う。
 *
 * @param {object} [args]
 * @param {import('./config.mjs').Config} [args.config] - ollama/openai-compat のendpoint発見に使う
 * @param {typeof runProcess} [args.runProcessImpl]
 * @param {typeof resolveCommand} [args.resolveCommandImpl]
 * @param {typeof fetchWithTimeout} [args.fetchImpl]
 * @param {string} [args.homedir] - codexキャッシュ探索の起点（既定 os.homedir()）
 * @returns {Promise<{adapters: Record<string, {models: string[], efforts: string[]}>}>}
 */
export async function discoverAdapterOptions({
  config,
  runProcessImpl = runProcess,
  resolveCommandImpl = resolveCommand,
  fetchImpl = fetchWithTimeout,
  homedir = os.homedir(),
} = {}) {
  const result = staticOptionsResponse();

  // codex: ~/.codex/models_cache.json
  try {
    const cachePath = path.join(homedir, ".codex", "models_cache.json");
    const slugs = parseCodexModelsCache(fs.readFileSync(cachePath, "utf8"));
    if (slugs.length > 0) result.adapters.codex.models = slugs;
  } catch {
    // ファイル無し・パース失敗 → 静的フォールバックのまま
  }

  // grok: `grok models`（shell:false・15sタイムアウト）
  try {
    const proc = await runProcessImpl({
      command: resolveCommandImpl("grok"),
      args: ["models"],
      timeoutMs: GROK_LIST_TIMEOUT_MS,
    });
    if (!proc.spawnError && !proc.timedOut && proc.code === 0) {
      const models = parseGrokModelsOutput(proc.stdout);
      if (models.length > 0) result.adapters.grok.models = models;
    }
  } catch {
    // runProcessは本来rejectしないが、注入実装が投げても静的フォールバックへ
  }

  // ollama: configのollama参加者のendpointから GET /api/tags
  const participants = config?.participants ?? [];
  const ollamaP = participants.find((p) => p.adapter === "ollama" && p.endpoint);
  if (ollamaP) {
    const json = await tryFetchJson(fetchImpl, /** @type {string} */ (ollamaP.endpoint), "/api/tags");
    result.adapters.ollama.models = json ? parseOllamaTags(json) : [];
  }

  // openai-compat: GET /v1/models
  const oaiP = participants.find((p) => p.adapter === "openai-compat" && p.endpoint);
  if (oaiP) {
    const json = await tryFetchJson(fetchImpl, /** @type {string} */ (oaiP.endpoint), "/v1/models");
    result.adapters["openai-compat"].models = json ? parseOpenAiModels(json) : [];
  }

  return result;
}
