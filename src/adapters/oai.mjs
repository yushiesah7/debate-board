// @ts-check
/**
 * OpenAI-compatible adapter (LM Studio / llama.cpp server / vLLM, etc.),
 * zero-dependency via built-in fetch.
 * POST {endpoint}/v1/chat/completions, body:
 *   { model, messages:[{role:"system",content:persona},{role:"user",content:promptText}],
 *     response_format:{type:"json_object"} }
 * Response body's `choices[0].message.content` is parsed into TurnResult.
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
 */
export function buildOaiRequestBody(participant, promptText) {
  return {
    model: participant?.model ?? "",
    messages: [
      { role: "system", content: participant?.persona ?? "" },
      { role: "user", content: promptText },
    ],
    response_format: { type: "json_object" },
  };
}

/**
 * Parse an OpenAI-compatible `/v1/chat/completions` JSON response body into
 * a TurnResult.
 * @param {unknown} data
 * @returns {import('./util.mjs').TurnResult}
 */
export function parseOaiResponse(data) {
  const content = /** @type {any} */ (data)?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("oai adapter: missing choices[0].message.content in response");
  }
  return normalizeTurnResult(parseModelJson(content));
}

/**
 * @param {import('../engine.mjs').SpeakCtx} ctx
 * @returns {Promise<import('./util.mjs').TurnResult>}
 */
export async function speak(ctx) {
  try {
    const { participant, promptText } = ctx;
    const url = `${normalizeEndpoint(participant.endpoint)}/v1/chat/completions`;
    const body = buildOaiRequestBody(participant, promptText);

    return await runWithRetry(async () => {
      const data = await fetchJson(url, body, DEFAULT_TIMEOUT_MS);
      return parseOaiResponse(data);
    }, 1);
  } catch (err) {
    // Belt and braces: no code path may throw out of an adapter.
    return failResult(err);
  }
}
