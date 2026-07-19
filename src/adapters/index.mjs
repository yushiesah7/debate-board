// @ts-check
/**
 * Adapter registry. `resolveAdapter(name)` maps a config `adapter` name to
 * its `speak(ctx) -> TurnResult` function.
 *
 * "human" is special-cased: it has no context-free `speak` function because
 * it needs a GUI bridge injected at server-start time. `resolveAdapter("human")`
 * returns `null` by design — callers must construct it via
 * `makeHuman(bridge)` from `./human.mjs` instead.
 */

import { speak as claudeSpeak } from "./claude.mjs";
import { speak as codexSpeak } from "./codex.mjs";
import { speak as grokSpeak } from "./grok.mjs";
import { speak as ollamaSpeak } from "./ollama.mjs";
import { speak as oaiSpeak } from "./oai.mjs";

/** Adapter names known to config validation, in spec order. */
export const ADAPTER_NAMES = ["claude", "codex", "grok", "ollama", "openai-compat", "human"];

const REGISTRY = {
  claude: claudeSpeak,
  codex: codexSpeak,
  grok: grokSpeak,
  ollama: ollamaSpeak,
  "openai-compat": oaiSpeak,
  // human: intentionally absent — see module doc above.
};

/**
 * @param {string} name
 * @returns {((ctx: import('../engine.mjs').SpeakCtx) => Promise<import('./util.mjs').TurnResult>) | null}
 */
export function resolveAdapter(name) {
  if (name === "human") return null;
  const fn = REGISTRY[name];
  if (!fn) {
    throw new Error(`unknown adapter: ${name}`);
  }
  return fn;
}
