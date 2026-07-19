// @ts-check
/**
 * Manual smoke test — calls a real CLI adapter exactly once with a dummy
 * topic and prints the resulting TurnResult. Not part of `node --test`;
 * run explicitly:
 *
 *   node test/smoke-adapters.mjs claude
 *   node test/smoke-adapters.mjs codex
 *   node test/smoke-adapters.mjs grok
 *
 * Uses only a dummy debate topic per repo policy (no real discussion
 * content in committed files).
 */

import { resolveAdapter } from "../src/adapters/index.mjs";

const DUMMY_TOPIC = "きのこ vs たけのこ";

/**
 * Official TURN_SCHEMA contract (strict-JSON-Schema compatible; codex's
 * backend rejects array schemas without `items` with a 400). The same schema
 * is distributed to the T1 engine side. `lane` enum is intentionally omitted
 * — value validation is the engine's applyCardOps responsibility.
 */
const SCHEMA_JSON = {
  type: "object",
  properties: {
    utterance: { type: "string" },
    cardOps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "move", "edit"] },
          cardId: { type: ["string", "null"] },
          lane: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
          body: { type: ["string", "null"] },
        },
        required: ["op", "cardId", "lane", "title", "body"],
        additionalProperties: false,
      },
    },
    noteUpdate: { type: ["string", "null"] },
    pass: { type: "boolean" },
  },
  required: ["utterance", "cardOps", "noteUpdate", "pass"],
  additionalProperties: false,
};

const PARTICIPANTS = {
  claude: { id: "smoke-claude", name: "smoke-claude", adapter: "claude", model: "sonnet", persona: "あなたは討論参加者です。" },
  codex: { id: "smoke-codex", name: "smoke-codex", adapter: "codex", persona: "あなたは討論参加者です。" },
  grok: { id: "smoke-grok", name: "smoke-grok", adapter: "grok", persona: "あなたは討論参加者です。" },
};

function buildPromptText(participant) {
  return [
    `お題: ${DUMMY_TOPIC}`,
    "ラウンド: 1/1",
    "あなたの意見を1文で述べ、必ず次のJSON形式のみで応答してください（説明文やコードフェンスは不要）:",
    '{"utterance":"...","cardOps":[],"noteUpdate":null,"pass":false}',
  ].join("\n");
}

async function main() {
  const name = process.argv[2];
  if (!name || !(name in PARTICIPANTS)) {
    console.error(`usage: node test/smoke-adapters.mjs <${Object.keys(PARTICIPANTS).join("|")}>`);
    process.exit(1);
  }

  const participant = PARTICIPANTS[name];
  const speak = resolveAdapter(participant.adapter);
  if (!speak) {
    console.error(`adapter "${participant.adapter}" has no direct speak() (human requires a bridge)`);
    process.exit(1);
  }

  const ctx = {
    participant,
    topic: DUMMY_TOPIC,
    round: 1,
    maxRounds: 1,
    boardSummary: "(まだカードはありません)",
    ownNote: "",
    recentTranscript: [],
    schemaJson: SCHEMA_JSON,
    promptText: buildPromptText(participant),
  };

  console.log(`[smoke] calling adapter=${participant.adapter} ...`);
  const start = Date.now();
  const result = await speak(ctx);
  const elapsedMs = Date.now() - start;

  console.log(`[smoke] elapsed=${elapsedMs}ms`);
  console.log(JSON.stringify(result, null, 2));

  if (result.error) {
    console.error(`[smoke] adapter reported an error (pass=${result.pass}): ${result.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[smoke] unexpected throw (adapters must never throw!):", err);
  process.exitCode = 1;
});
