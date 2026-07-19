// @ts-check
/**
 * node --test suite for src/adapters/* and src/config.mjs.
 * Uses dummy topics only (per repo policy) and never invokes real CLIs —
 * CLI adapters are tested via their pure argv-builder / output-parser
 * functions. HTTP adapters (ollama/oai) are tested against local
 * node:http mock servers.
 */

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  failResult,
  normalizeTurnResult,
  parseModelJson,
  stripCodeFence,
  resolveCommand,
} from "../src/adapters/util.mjs";

import { buildClaudeArgs, parseClaudeOutput } from "../src/adapters/claude.mjs";
import { buildCodexArgs, parseCodexOutput } from "../src/adapters/codex.mjs";
import { buildGrokArgs, parseGrokOutput } from "../src/adapters/grok.mjs";
import {
  buildOllamaRequestBody,
  parseOllamaResponse,
  speak as ollamaSpeak,
} from "../src/adapters/ollama.mjs";
import {
  buildOaiRequestBody,
  parseOaiResponse,
  speak as oaiSpeak,
} from "../src/adapters/oai.mjs";
import { makeHuman, HUMAN_TIMEOUT_MS } from "../src/adapters/human.mjs";
import { resolveAdapter, ADAPTER_NAMES } from "../src/adapters/index.mjs";
import { validateConfig, DEFAULT_PORT, DEFAULT_MAX_ROUNDS } from "../src/config.mjs";

const DUMMY_TOPIC = "きのこ vs たけのこ";

function makeCtx(overrides = {}) {
  return {
    participant: { id: "p1", name: "参加者1", adapter: "claude", model: "sonnet", persona: "テスト用ペルソナ" },
    topic: DUMMY_TOPIC,
    round: 1,
    maxRounds: 4,
    boardSummary: "",
    ownNote: "",
    recentTranscript: [],
    schemaJson: { type: "object" },
    promptText: `お題: ${DUMMY_TOPIC}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Common normalization utilities
// ---------------------------------------------------------------------------

test("stripCodeFence removes a ```json fence", () => {
  const fenced = "```json\n{\"a\":1}\n```";
  assert.equal(stripCodeFence(fenced), '{"a":1}');
});

test("stripCodeFence removes a bare ``` fence", () => {
  const fenced = "```\n{\"a\":1}\n```";
  assert.equal(stripCodeFence(fenced), '{"a":1}');
});

test("stripCodeFence leaves unfenced text untouched", () => {
  assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');
});

test("parseModelJson parses fenced JSON", () => {
  const parsed = parseModelJson("```json\n{\"utterance\":\"hi\"}\n```");
  assert.deepEqual(parsed, { utterance: "hi" });
});

test("parseModelJson extracts JSON embedded in prose", () => {
  const parsed = parseModelJson('here is my answer: {"utterance":"hi"} thanks');
  assert.deepEqual(parsed, { utterance: "hi" });
});

test("parseModelJson throws on garbage input", () => {
  assert.throws(() => parseModelJson("not json at all"));
});

test("normalizeTurnResult fills defaults for missing fields", () => {
  const result = normalizeTurnResult({ utterance: "hello" });
  assert.deepEqual(result, {
    utterance: "hello",
    cardOps: [],
    noteUpdate: null,
    pass: false,
    error: null,
  });
});

test("normalizeTurnResult preserves valid cardOps/noteUpdate/pass", () => {
  const result = normalizeTurnResult({
    utterance: "ok",
    cardOps: [{ op: "add", lane: "decided", title: "t", body: "b" }],
    noteUpdate: "my note",
    pass: true,
  });
  assert.equal(result.cardOps.length, 1);
  assert.equal(result.noteUpdate, "my note");
  assert.equal(result.pass, true);
});

test("normalizeTurnResult accepts strict-schema cardOps with null-filled fields", () => {
  // The strict TURN_SCHEMA requires op/cardId/lane/title/body on every card
  // op, so `add` ops arrive with cardId:null etc. — must be treated as normal.
  const result = normalizeTurnResult({
    utterance: "ok",
    cardOps: [
      { op: "add", cardId: null, lane: "discussing", title: "新論点", body: "本文" },
      { op: "move", cardId: "c3", lane: "decided", title: null, body: null },
    ],
    noteUpdate: null,
    pass: false,
  });
  assert.equal(result.cardOps.length, 2);
  assert.equal(result.cardOps[0].cardId, null);
  assert.equal(result.cardOps[1].title, null);
  assert.equal(result.error, null);
});

test("normalizeTurnResult throws on non-object input", () => {
  assert.throws(() => normalizeTurnResult(null));
  assert.throws(() => normalizeTurnResult("a string"));
  assert.throws(() => normalizeTurnResult([1, 2, 3]));
});

test("failResult never throws and always sets pass:true + error", () => {
  const r = failResult(new Error("boom"));
  assert.equal(r.pass, true);
  assert.equal(r.utterance, "");
  assert.deepEqual(r.cardOps, []);
  assert.equal(r.noteUpdate, null);
  assert.equal(r.error, "boom");
});

test("resolveCommand is a no-op on non-Windows platforms", () => {
  if (process.platform !== "win32") {
    assert.equal(resolveCommand("claude"), "claude");
  } else {
    assert.equal(typeof resolveCommand("claude"), "string");
  }
});

// ---------------------------------------------------------------------------
// claude adapter: argv + output parsing (no real spawn)
// ---------------------------------------------------------------------------

test("buildClaudeArgs builds expected argv", () => {
  const args = buildClaudeArgs({ model: "sonnet", persona: "あなたは司会です" });
  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "json",
    "--model",
    "sonnet",
    "--system-prompt",
    "あなたは司会です",
  ]);
});

test("parseClaudeOutput extracts result field and parses nested JSON", () => {
  const envelope = JSON.stringify({
    result: JSON.stringify({ utterance: "こんにちは", pass: false }),
  });
  const parsed = parseClaudeOutput(envelope);
  assert.equal(parsed.utterance, "こんにちは");
  assert.equal(parsed.pass, false);
  assert.equal(parsed.error, null);
});

test("parseClaudeOutput handles a fenced result field", () => {
  const envelope = JSON.stringify({
    result: "```json\n{\"utterance\":\"ok\",\"pass\":true}\n```",
  });
  const parsed = parseClaudeOutput(envelope);
  assert.equal(parsed.utterance, "ok");
  assert.equal(parsed.pass, true);
});

test("parseClaudeOutput throws on unparsable envelope", () => {
  assert.throws(() => parseClaudeOutput("not json"));
});

// ---------------------------------------------------------------------------
// codex adapter: argv + JSONL output parsing (no real spawn)
// ---------------------------------------------------------------------------

test("buildCodexArgs builds expected argv (incl. MCP disable)", () => {
  const args = buildCodexArgs({ schemaFilePath: "/tmp/schema.json", cwd: "/tmp/wd" });
  assert.deepEqual(args, [
    "exec",
    "--json",
    "--output-schema",
    "/tmp/schema.json",
    "--skip-git-repo-check",
    "-C",
    "/tmp/wd",
    "-c",
    "mcp_servers={}",
  ]);
});

test("parseCodexOutput extracts agent_message from real envelope JSONL", () => {
  // Fixture matches the real codex CLI envelope (verified 2026-07-20).
  const jsonl = [
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "agent_message",
        text: JSON.stringify({ utterance: "決定です", cardOps: [], noteUpdate: null, pass: false }),
      },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }),
  ].join("\n");
  const parsed = parseCodexOutput(jsonl);
  assert.equal(parsed.utterance, "決定です");
  assert.equal(parsed.pass, false);
  assert.equal(parsed.error, null);
});

test("parseCodexOutput uses the LAST agent_message when several exist", () => {
  const jsonl = [
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: '{"utterance":"古い方"}' },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: '{"utterance":"新しい方","pass":true}' },
    }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n");
  const parsed = parseCodexOutput(jsonl);
  assert.equal(parsed.utterance, "新しい方");
  assert.equal(parsed.pass, true);
});

test("parseCodexOutput strips a code fence inside item.text", () => {
  const jsonl = JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_0",
      type: "agent_message",
      text: "```json\n{\"utterance\":\"フェンス付き\",\"pass\":false}\n```",
    },
  });
  const parsed = parseCodexOutput(jsonl);
  assert.equal(parsed.utterance, "フェンス付き");
});

test("parseCodexOutput ignores non-agent_message item.completed lines", () => {
  const jsonl = [
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "command_execution", text: "ls -la" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: '{"utterance":"本命"}' },
    }),
  ].join("\n");
  const parsed = parseCodexOutput(jsonl);
  assert.equal(parsed.utterance, "本命");
});

test("parseCodexOutput throws with root cause on turn.failed (exit 0 case)", () => {
  const jsonl = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({
      type: "turn.failed",
      message: "unexpected status 400 Bad Request: cardOps array schema missing items",
    }),
  ].join("\n");
  assert.throws(() => parseCodexOutput(jsonl), /turn\.failed.*missing items/);
});

test("parseCodexOutput throws with root cause on error event", () => {
  const jsonl = JSON.stringify({ type: "error", message: "something exploded" });
  assert.throws(() => parseCodexOutput(jsonl), /error: something exploded/);
});

test("parseCodexOutput surfaces nested error.message on turn.failed", () => {
  const jsonl = JSON.stringify({ type: "turn.failed", error: { message: "nested cause" } });
  assert.throws(() => parseCodexOutput(jsonl), /turn\.failed: nested cause/);
});

test("parseCodexOutput prefers agent_message even when a failure event also exists", () => {
  // A usable agent_message must not be masked by post-hoc failure noise.
  const jsonl = [
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: '{"utterance":"成功分"}' },
    }),
    JSON.stringify({ type: "error", message: "post-hoc noise" }),
  ].join("\n");
  const parsed = parseCodexOutput(jsonl);
  assert.equal(parsed.utterance, "成功分");
});

test("parseCodexOutput falls back to candidate-key extraction for unknown shapes", () => {
  const jsonl = [
    JSON.stringify({ type: "log", msg: "starting" }),
    JSON.stringify({ type: "something.new", content: { utterance: "決定です", pass: false } }),
  ].join("\n");
  const parsed = parseCodexOutput(jsonl);
  assert.equal(parsed.utterance, "決定です");
});

test("parseCodexOutput accepts a line that is itself the turn result", () => {
  const jsonl = JSON.stringify({ utterance: "直接", cardOps: [], pass: true });
  const parsed = parseCodexOutput(jsonl);
  assert.equal(parsed.utterance, "直接");
  assert.equal(parsed.pass, true);
});

test("parseCodexOutput throws when no usable line exists", () => {
  const jsonl = [JSON.stringify({ type: "log", msg: "noise" })].join("\n");
  assert.throws(() => parseCodexOutput(jsonl));
});

test("parseCodexOutput throws on empty output", () => {
  assert.throws(() => parseCodexOutput(""));
});

// ---------------------------------------------------------------------------
// grok adapter: argv + output parsing (no real spawn)
// ---------------------------------------------------------------------------

test("buildGrokArgs builds expected argv", () => {
  const args = buildGrokArgs({
    promptText: "お題です",
    schemaJson: { type: "object" },
    persona: "ロキです",
    cwd: "/tmp/grokwd",
  });
  assert.deepEqual(args, [
    "-p",
    "お題です",
    "--json-schema",
    JSON.stringify({ type: "object" }),
    "--output-format",
    "json",
    "--system-prompt-override",
    "ロキです",
    "--cwd",
    "/tmp/grokwd",
    "--no-memory",
    "--disable-web-search",
    "--permission-mode",
    "dontAsk",
    "--max-turns",
    "3",
  ]);
});

test("parseGrokOutput prefers structuredOutput", () => {
  const stdout = JSON.stringify({
    structuredOutput: { utterance: "構造化済み", pass: false },
    text: '{"utterance":"無視される"}',
  });
  const parsed = parseGrokOutput(stdout);
  assert.equal(parsed.utterance, "構造化済み");
});

test("parseGrokOutput falls back to parsing text field", () => {
  const stdout = JSON.stringify({ text: '{"utterance":"テキストから","pass":true}' });
  const parsed = parseGrokOutput(stdout);
  assert.equal(parsed.utterance, "テキストから");
  assert.equal(parsed.pass, true);
});

test("parseGrokOutput throws on garbage stdout", () => {
  assert.throws(() => parseGrokOutput("not json"));
});

// ---------------------------------------------------------------------------
// ollama adapter: body builder + mock HTTP server
// ---------------------------------------------------------------------------

test("buildOllamaRequestBody shapes the /api/chat request", () => {
  const body = buildOllamaRequestBody(
    { model: "qwen3", persona: "ペルソナ" },
    "プロンプト本文",
    { type: "object" }
  );
  assert.equal(body.model, "qwen3");
  assert.equal(body.stream, false);
  assert.deepEqual(body.format, { type: "object" });
  assert.deepEqual(body.messages, [
    { role: "system", content: "ペルソナ" },
    { role: "user", content: "プロンプト本文" },
  ]);
});

test("parseOllamaResponse parses message.content", () => {
  const parsed = parseOllamaResponse({ message: { content: '{"utterance":"ok"}' } });
  assert.equal(parsed.utterance, "ok");
});

test("ollama speak() normalizes a well-formed mock server response", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: { content: '{"utterance":"モックOK","pass":false}' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = /** @type {any} */ (server.address());
    const ctx = makeCtx({
      participant: { id: "local", name: "ローカル", adapter: "ollama", model: "qwen3", endpoint: `http://127.0.0.1:${port}` },
    });
    const result = await ollamaSpeak(ctx);
    assert.equal(result.utterance, "モックOK");
    assert.equal(result.error, null);
  } finally {
    server.close();
  }
});

test("ollama speak() returns pass+error on malformed JSON body", async () => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: { content: "not valid json {{{" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = /** @type {any} */ (server.address());
    const ctx = makeCtx({
      participant: { id: "local", name: "ローカル", adapter: "ollama", model: "qwen3", endpoint: `http://127.0.0.1:${port}` },
    });
    const result = await ollamaSpeak(ctx);
    assert.equal(result.pass, true);
    assert.notEqual(result.error, null);
  } finally {
    server.close();
  }
});

test("ollama speak() returns pass+error on HTTP error status", async () => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = /** @type {any} */ (server.address());
    const ctx = makeCtx({
      participant: { id: "local", name: "ローカル", adapter: "ollama", model: "qwen3", endpoint: `http://127.0.0.1:${port}` },
    });
    const result = await ollamaSpeak(ctx);
    assert.equal(result.pass, true);
    assert.notEqual(result.error, null);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// oai (openai-compat) adapter: body builder + mock HTTP server
// ---------------------------------------------------------------------------

test("buildOaiRequestBody shapes the /v1/chat/completions request", () => {
  const body = buildOaiRequestBody({ model: "local-model", persona: "ペルソナ" }, "プロンプト本文");
  assert.equal(body.model, "local-model");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.messages, [
    { role: "system", content: "ペルソナ" },
    { role: "user", content: "プロンプト本文" },
  ]);
});

test("parseOaiResponse parses choices[0].message.content", () => {
  const parsed = parseOaiResponse({ choices: [{ message: { content: '{"utterance":"ok"}' } }] });
  assert.equal(parsed.utterance, "ok");
});

test("oai speak() normalizes a well-formed mock server response", async () => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"utterance":"OAIモックOK","pass":false}' } }],
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = /** @type {any} */ (server.address());
    const ctx = makeCtx({
      participant: { id: "local", name: "ローカル", adapter: "openai-compat", model: "m", endpoint: `http://127.0.0.1:${port}` },
    });
    const result = await oaiSpeak(ctx);
    assert.equal(result.utterance, "OAIモックOK");
    assert.equal(result.error, null);
  } finally {
    server.close();
  }
});

test("oai speak() returns pass+error on malformed JSON body", async () => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{{{ broken" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = /** @type {any} */ (server.address());
    const ctx = makeCtx({
      participant: { id: "local", name: "ローカル", adapter: "openai-compat", model: "m", endpoint: `http://127.0.0.1:${port}` },
    });
    const result = await oaiSpeak(ctx);
    assert.equal(result.pass, true);
    assert.notEqual(result.error, null);
  } finally {
    server.close();
  }
});

test("oai speak() returns pass+error on HTTP error status", async () => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = /** @type {any} */ (server.address());
    const ctx = makeCtx({
      participant: { id: "local", name: "ローカル", adapter: "openai-compat", model: "m", endpoint: `http://127.0.0.1:${port}` },
    });
    const result = await oaiSpeak(ctx);
    assert.equal(result.pass, true);
    assert.notEqual(result.error, null);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// human adapter
// ---------------------------------------------------------------------------

test("human speak() returns utterance when bridge resolves with text", async () => {
  const bridge = { wait: async () => ({ text: "人間の発言です" }) };
  const { speak } = makeHuman(bridge);
  const result = await speak(makeCtx({ participant: { id: "you", name: "あなた", adapter: "human" } }));
  assert.equal(result.utterance, "人間の発言です");
  assert.equal(result.pass, false);
});

test("human speak() passes when bridge resolves with skip", async () => {
  const bridge = { wait: async () => ({ skip: true }) };
  const { speak } = makeHuman(bridge);
  const result = await speak(makeCtx({ participant: { id: "you", name: "あなた", adapter: "human" } }));
  assert.equal(result.pass, true);
  assert.equal(result.error, null);
});

test("human speak() passes with error when bridge rejects (e.g. timeout)", async () => {
  const bridge = { wait: async () => { throw new Error("timed out"); } };
  const { speak } = makeHuman(bridge);
  const result = await speak(makeCtx({ participant: { id: "you", name: "あなた", adapter: "human" } }));
  assert.equal(result.pass, true);
  assert.equal(result.error, "timed out");
});

test("HUMAN_TIMEOUT_MS is 5 minutes per spec", () => {
  assert.equal(HUMAN_TIMEOUT_MS, 5 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// adapter registry
// ---------------------------------------------------------------------------

test("resolveAdapter resolves known adapters to functions", () => {
  for (const name of ["claude", "codex", "grok", "ollama", "openai-compat"]) {
    assert.equal(typeof resolveAdapter(name), "function");
  }
});

test("resolveAdapter('human') returns null by design", () => {
  assert.equal(resolveAdapter("human"), null);
});

test("resolveAdapter throws on unknown adapter name", () => {
  assert.throws(() => resolveAdapter("not-a-real-adapter"));
});

test("ADAPTER_NAMES includes all spec adapter kinds", () => {
  for (const name of ["claude", "codex", "grok", "ollama", "openai-compat", "human"]) {
    assert.ok(ADAPTER_NAMES.includes(name));
  }
});

// ---------------------------------------------------------------------------
// config validation
// ---------------------------------------------------------------------------

test("validateConfig fills in port/maxRounds defaults", () => {
  const cfg = validateConfig({
    participants: [{ id: "a", name: "A", adapter: "claude", enabled: true }],
  });
  assert.equal(cfg.port, DEFAULT_PORT);
  assert.equal(cfg.maxRounds, DEFAULT_MAX_ROUNDS);
});

test("validateConfig preserves explicit port/maxRounds", () => {
  const cfg = validateConfig({
    port: 9000,
    maxRounds: 6,
    participants: [{ id: "a", name: "A", adapter: "claude", enabled: true }],
  });
  assert.equal(cfg.port, 9000);
  assert.equal(cfg.maxRounds, 6);
});

test("validateConfig rejects empty participants", () => {
  assert.throws(() => validateConfig({ participants: [] }));
});

test("validateConfig rejects missing participants", () => {
  assert.throws(() => validateConfig({}));
});

test("validateConfig rejects duplicate participant ids", () => {
  assert.throws(() =>
    validateConfig({
      participants: [
        { id: "a", name: "A", adapter: "claude", enabled: true },
        { id: "a", name: "A2", adapter: "codex", enabled: true },
      ],
    })
  );
});

test("validateConfig rejects unknown adapter name", () => {
  assert.throws(() =>
    validateConfig({
      participants: [{ id: "a", name: "A", adapter: "not-real", enabled: true }],
    })
  );
});

test("validateConfig accepts the shipped config.example.json shape", () => {
  const cfg = validateConfig({
    port: 8787,
    maxRounds: 4,
    participants: [
      { id: "nagi", name: "凪", adapter: "claude", model: "sonnet", enabled: true },
      { id: "aki", name: "アキ", adapter: "codex", enabled: true },
      { id: "roki", name: "ロキ", adapter: "grok", enabled: true },
      { id: "local", name: "ローカルLLM", adapter: "ollama", model: "qwen3", endpoint: "http://127.0.0.1:11434", enabled: false },
      { id: "you", name: "あなた", adapter: "human", enabled: false },
    ],
  });
  assert.equal(cfg.participants.length, 5);
});
