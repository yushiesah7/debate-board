// @ts-check
/**
 * Ollama adapter (local LLM over HTTP, zero-dependency via built-in fetch).
 * POST {endpoint}/api/chat, body:
 *   { model, messages:[{role:"system",content:persona},{role:"user",content:promptText}],
 *     stream:false, format: schemaJson }
 * Response body's `message.content` is parsed into the common TurnResult.
 */

import {
  fetchJson,
  normalizeEndpoint,
  parseModelJson,
  normalizeTurnResult,
  runWithRetry,
  failResult,
  DEFAULT_TIMEOUT_MS,
} from "./util.mjs";

/**
 * Pure request-body builder — unit-testable without any network call.
 * @param {{model?:string, persona?:string}} participant
 * @param {string} promptText
 * @param {object} schemaJson
 */
export function buildOllamaRequestBody(participant, promptText, schemaJson) {
  return {
    model: participant?.model ?? "",
    messages: [
      { role: "system", content: participant?.persona ?? "" },
      { role: "user", content: promptText },
    ],
    stream: false,
    format: schemaJson,
  };
}

/**
 * Parse an Ollama `/api/chat` JSON response body into a TurnResult.
 * @param {unknown} data
 * @returns {import('./util.mjs').TurnResult}
 */
export function parseOllamaResponse(data) {
  const content = /** @type {any} */ (data)?.message?.content;
  if (typeof content !== "string") {
    throw new Error("ollama adapter: missing message.content in response");
  }
  return normalizeTurnResult(parseModelJson(content));
}

/**
 * @param {import('../engine.mjs').SpeakCtx} ctx
 * @returns {Promise<import('./util.mjs').TurnResult>}
 */
export async function speak(ctx) {
  try {
    const { participant, promptText, schemaJson } = ctx;
    const url = `${normalizeEndpoint(participant.endpoint)}/api/chat`;
    const body = buildOllamaRequestBody(participant, promptText, schemaJson);

    return await runWithRetry(async () => {
      const data = await fetchJson(url, body, DEFAULT_TIMEOUT_MS);
      return parseOllamaResponse(data);
    }, 1);
  } catch (err) {
    // Belt and braces: no code path may throw out of an adapter.
    return failResult(err);
  }
}
