// @ts-check
/**
 * node --test suite for src/adapters/* and src/config.mjs.
 * Uses dummy topics only (per repo policy) and never invokes real CLIs —
 * CLI adapters are tested via their pure argv-builder / output-parser
 * functions. HTTP adapters (ollama/oai) are tested against local
 * node:http mock servers.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import test from "node:test";

import {
  failResult,
  normalizeTurnResult,
  parseModelJson,
  stripCodeFence,
  resolveCommand,
  runProcess,
  normalizeEndpoint,
  removeDirQuietly,
  makeTempDir,
  MAX_OUTPUT_BYTES,
} from "../src/adapters/util.mjs";

import { buildClaudeArgs, parseClaudeOutput } from "../src/adapters/claude.mjs";
import {
  buildCodexArgs,
  buildCodexInput,
  parseCodexOutput,
  speak as codexSpeak,
} from "../src/adapters/codex.mjs";
import { buildGrokArgs, parseGrokOutput, speak as grokSpeak } from "../src/adapters/grok.mjs";
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

test("buildClaudeArgs builds expected argv (pcAccess read = no extra flags)", () => {
  const expected = [
    "-p",
    "--output-format",
    "json",
    "--model",
    "sonnet",
    "--system-prompt",
    "あなたは司会です",
  ];
  assert.deepEqual(buildClaudeArgs({ model: "sonnet", persona: "あなたは司会です" }), expected);
  assert.deepEqual(
    buildClaudeArgs({ model: "sonnet", persona: "あなたは司会です", pcAccess: "read" }),
    expected
  );
});

test("buildClaudeArgs adds bypassPermissions for pcAccess full", () => {
  const args = buildClaudeArgs({ model: "sonnet", persona: "p", pcAccess: "full" });
  assert.deepEqual(args.slice(-2), ["--permission-mode", "bypassPermissions"]);
});

test("buildClaudeArgs adds --effort only when specified", () => {
  const withEffort = buildClaudeArgs({ model: "sonnet", persona: "p", effort: "medium" });
  assert.deepEqual(withEffort.slice(-2), ["--effort", "medium"]);
  const without = buildClaudeArgs({ model: "sonnet", persona: "p" });
  assert.ok(!without.includes("--effort"));
});

test("buildClaudeArgs combines effort and pcAccess full", () => {
  const args = buildClaudeArgs({ model: "sonnet", persona: "p", effort: "high", pcAccess: "full" });
  assert.deepEqual(args.slice(-4), ["--effort", "high", "--permission-mode", "bypassPermissions"]);
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

test("buildCodexArgs builds expected argv (incl. MCP disable, read sandbox default)", () => {
  const expected = [
    "exec",
    "--json",
    "--output-schema",
    "/tmp/schema.json",
    "--skip-git-repo-check",
    "-C",
    "/tmp/wd",
    "-c",
    "mcp_servers={}",
    "--sandbox",
    "read-only",
  ];
  assert.deepEqual(buildCodexArgs({ schemaFilePath: "/tmp/schema.json", cwd: "/tmp/wd" }), expected);
  assert.deepEqual(
    buildCodexArgs({ schemaFilePath: "/tmp/schema.json", cwd: "/tmp/wd", pcAccess: "read" }),
    expected
  );
});

test("buildCodexArgs uses danger-full-access sandbox for pcAccess full", () => {
  const args = buildCodexArgs({ schemaFilePath: "/tmp/s.json", cwd: "/tmp/wd", pcAccess: "full" });
  assert.deepEqual(args.slice(-2), ["--sandbox", "danger-full-access"]);
});

test("buildCodexArgs appends -m when model is configured", () => {
  const args = buildCodexArgs({ schemaFilePath: "/tmp/s.json", cwd: "/tmp/wd", model: "o3" });
  assert.deepEqual(args.slice(-2), ["-m", "o3"]);
});

test("buildCodexArgs appends model_reasoning_effort only when effort is configured", () => {
  const withEffort = buildCodexArgs({ schemaFilePath: "/tmp/s.json", cwd: "/tmp/wd", effort: "medium" });
  assert.deepEqual(withEffort.slice(-2), ["-c", "model_reasoning_effort=medium"]);
  const without = buildCodexArgs({ schemaFilePath: "/tmp/s.json", cwd: "/tmp/wd" });
  assert.ok(!without.some((a) => a.startsWith("model_reasoning_effort=")));
});

test("buildCodexArgs combines model and effort (model first, then effort)", () => {
  const args = buildCodexArgs({ schemaFilePath: "/tmp/s.json", cwd: "/tmp/wd", model: "o3", effort: "high" });
  assert.deepEqual(args.slice(-4), ["-m", "o3", "-c", "model_reasoning_effort=high"]);
});

test("buildCodexInput prepends persona to the stdin prompt", () => {
  assert.equal(buildCodexInput("ペルソナ", "本文"), "ペルソナ\n\n本文");
  assert.equal(buildCodexInput(undefined, "本文"), "本文");
  assert.equal(buildCodexInput("", "本文"), "本文");
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

test("buildGrokArgs builds expected argv (pcAccess read default: plan / 6 turns)", () => {
  const expected = [
    "--prompt-file",
    "/tmp/grokwd/prompt.txt",
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
    "plan",
    "--max-turns",
    "6",
  ];
  assert.deepEqual(
    buildGrokArgs({
      promptFilePath: "/tmp/grokwd/prompt.txt",
      schemaJson: { type: "object" },
      persona: "ロキです",
      cwd: "/tmp/grokwd",
    }),
    expected
  );
  assert.deepEqual(
    buildGrokArgs({
      promptFilePath: "/tmp/grokwd/prompt.txt",
      schemaJson: { type: "object" },
      persona: "ロキです",
      cwd: "/tmp/grokwd",
      pcAccess: "read",
    }),
    expected
  );
});

test("buildGrokArgs uses bypassPermissions / 10 turns for pcAccess full", () => {
  const args = buildGrokArgs({
    promptFilePath: "/tmp/grokwd/prompt.txt",
    schemaJson: { type: "object" },
    persona: "ロキです",
    cwd: "/tmp/grokwd",
    pcAccess: "full",
  });
  assert.deepEqual(args.slice(-4), ["--permission-mode", "bypassPermissions", "--max-turns", "10"]);
});

test("buildGrokArgs appends -m only when model is configured", () => {
  const base = { promptFilePath: "/tmp/p.txt", schemaJson: {}, cwd: "/tmp/wd" };
  const withModel = buildGrokArgs({ ...base, model: "grok-4" });
  assert.deepEqual(withModel.slice(-2), ["-m", "grok-4"]);
  const without = buildGrokArgs(base);
  assert.ok(!without.includes("-m"));
});

test("buildGrokArgs appends --reasoning-effort only when effort is configured", () => {
  const base = { promptFilePath: "/tmp/p.txt", schemaJson: {}, cwd: "/tmp/wd" };
  const withEffort = buildGrokArgs({ ...base, effort: "medium" });
  assert.deepEqual(withEffort.slice(-2), ["--reasoning-effort", "medium"]);
  const without = buildGrokArgs(base);
  assert.ok(!without.includes("--reasoning-effort"));
});

test("buildGrokArgs combines model and effort after the pcAccess flags", () => {
  const args = buildGrokArgs({
    promptFilePath: "/tmp/p.txt",
    schemaJson: {},
    cwd: "/tmp/wd",
    pcAccess: "full",
    model: "grok-4",
    effort: "high",
  });
  assert.deepEqual(args.slice(-8), [
    "--permission-mode",
    "bypassPermissions",
    "--max-turns",
    "10",
    "-m",
    "grok-4",
    "--reasoning-effort",
    "high",
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
    // Error must carry a snippet of the response body for diagnosis.
    assert.match(String(result.error), /internal error/);
  } finally {
    server.close();
  }
});

test("ollama speak() strips trailing slashes from endpoint", async () => {
  /** @type {string[]} */
  const seenUrls = [];
  const server = http.createServer((req, res) => {
    seenUrls.push(req.url ?? "");
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: { content: '{"utterance":"ok"}' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = /** @type {any} */ (server.address());
    const ctx = makeCtx({
      participant: { id: "local", name: "ローカル", adapter: "ollama", model: "qwen3", endpoint: `http://127.0.0.1:${port}///` },
    });
    const result = await ollamaSpeak(ctx);
    assert.equal(result.utterance, "ok");
    assert.deepEqual(seenUrls, ["/api/chat"]);
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
      { id: "nagi", name: "凪", adapter: "claude", model: "sonnet", effort: "medium", pcAccess: "read", enabled: true },
      { id: "aki", name: "アキ", adapter: "codex", effort: "medium", pcAccess: "read", enabled: true },
      { id: "roki", name: "ロキ", adapter: "grok", effort: "medium", pcAccess: "read", enabled: true },
      { id: "local", name: "ローカルLLM", adapter: "ollama", model: "qwen3", endpoint: "http://127.0.0.1:11434", enabled: false },
      { id: "you", name: "あなた", adapter: "human", enabled: false },
    ],
  });
  assert.equal(cfg.participants.length, 5);
});

// ---------------------------------------------------------------------------
// config validation: pcAccess
// ---------------------------------------------------------------------------

test("validateConfig fills pcAccess default 'read' when omitted", () => {
  const cfg = validateConfig({
    participants: [{ id: "a", name: "A", adapter: "claude", enabled: true }],
  });
  assert.equal(cfg.participants[0].pcAccess, "read");
});

test("validateConfig preserves explicit pcAccess values", () => {
  const cfg = validateConfig({
    participants: [
      { id: "a", name: "A", adapter: "claude", pcAccess: "full", enabled: true },
      { id: "b", name: "B", adapter: "codex", pcAccess: "read", enabled: true },
    ],
  });
  assert.equal(cfg.participants[0].pcAccess, "full");
  assert.equal(cfg.participants[1].pcAccess, "read");
});

test("validateConfig rejects invalid pcAccess values", () => {
  for (const bad of ["write", "FULL", "", 1, true, null]) {
    assert.throws(
      () =>
        validateConfig({
          participants: [{ id: "a", name: "A", adapter: "claude", pcAccess: bad, enabled: true }],
        }),
      undefined,
      `expected pcAccess=${JSON.stringify(bad)} to be rejected`
    );
  }
});

test("validateConfig accepts (and normalizes) pcAccess on non-CLI adapters too", () => {
  // ollama/openai-compat/human ignore pcAccess at runtime, but a valid value
  // must not be rejected, and the default is still filled in.
  const cfg = validateConfig({
    participants: [
      { id: "local", name: "L", adapter: "ollama", endpoint: "http://127.0.0.1:11434", pcAccess: "full", enabled: false },
      { id: "you", name: "Y", adapter: "human", enabled: false },
    ],
  });
  assert.equal(cfg.participants[0].pcAccess, "full");
  assert.equal(cfg.participants[1].pcAccess, "read");
});

// ---------------------------------------------------------------------------
// config validation: effort
// ---------------------------------------------------------------------------

test("validateConfig accepts omitted effort and passes explicit effort through", () => {
  const cfg = validateConfig({
    participants: [
      { id: "a", name: "A", adapter: "claude", enabled: true },
      { id: "b", name: "B", adapter: "codex", effort: "medium", enabled: true },
      // Deliberately not a claude/codex level name — values are passthrough,
      // per-CLI validity is the CLI's own job.
      { id: "c", name: "C", adapter: "grok", effort: "ultrathink", enabled: true },
    ],
  });
  assert.equal(cfg.participants[0].effort, undefined);
  assert.equal(cfg.participants[1].effort, "medium");
  assert.equal(cfg.participants[2].effort, "ultrathink");
});

test("validateConfig rejects empty or non-string effort", () => {
  for (const bad of ["", "   ", 3, true, null, {}]) {
    assert.throws(
      () =>
        validateConfig({
          participants: [{ id: "a", name: "A", adapter: "claude", effort: bad, enabled: true }],
        }),
      undefined,
      `expected effort=${JSON.stringify(bad)} to be rejected`
    );
  }
});

test("validateConfig accepts effort on non-CLI adapters (ignored at runtime)", () => {
  const cfg = validateConfig({
    participants: [
      { id: "local", name: "L", adapter: "ollama", endpoint: "http://127.0.0.1:11434", effort: "high", enabled: false },
      { id: "you", name: "Y", adapter: "human", effort: "low", enabled: false },
    ],
  });
  assert.equal(cfg.participants[0].effort, "high");
  assert.equal(cfg.participants[1].effort, "low");
});

// ---------------------------------------------------------------------------
// config validation: strengthened rules (endpoint / port / maxRounds / name /
// enabled / human count)
// ---------------------------------------------------------------------------

test("validateConfig requires endpoint for ollama/openai-compat", () => {
  assert.throws(() =>
    validateConfig({
      participants: [{ id: "a", name: "A", adapter: "ollama", model: "m", enabled: true }],
    })
  );
  assert.throws(() =>
    validateConfig({
      participants: [{ id: "a", name: "A", adapter: "openai-compat", model: "m", endpoint: "", enabled: true }],
    })
  );
});

test("validateConfig rejects unparsable endpoint URLs", () => {
  assert.throws(() =>
    validateConfig({
      participants: [{ id: "a", name: "A", adapter: "ollama", endpoint: "not a url", enabled: true }],
    })
  );
});

test("validateConfig rejects invalid port values", () => {
  const participants = [{ id: "a", name: "A", adapter: "claude", enabled: true }];
  assert.throws(() => validateConfig({ port: 0, participants }));
  assert.throws(() => validateConfig({ port: 65536, participants }));
  assert.throws(() => validateConfig({ port: 3.5, participants }));
  assert.throws(() => validateConfig({ port: "8787", participants }));
});

test("validateConfig rejects invalid maxRounds values", () => {
  const participants = [{ id: "a", name: "A", adapter: "claude", enabled: true }];
  assert.throws(() => validateConfig({ maxRounds: 0, participants }));
  assert.throws(() => validateConfig({ maxRounds: 2.5, participants }));
  assert.throws(() => validateConfig({ maxRounds: "4", participants }));
});

test("validateConfig requires a non-empty participant name", () => {
  assert.throws(() =>
    validateConfig({ participants: [{ id: "a", adapter: "claude", enabled: true }] })
  );
  assert.throws(() =>
    validateConfig({ participants: [{ id: "a", name: "", adapter: "claude", enabled: true }] })
  );
});

test("validateConfig defaults enabled to true and rejects non-boolean", () => {
  const cfg = validateConfig({
    participants: [{ id: "a", name: "A", adapter: "claude" }],
  });
  assert.equal(cfg.participants[0].enabled, true);
  assert.throws(() =>
    validateConfig({ participants: [{ id: "a", name: "A", adapter: "claude", enabled: "yes" }] })
  );
});

test("validateConfig allows at most one human participant", () => {
  assert.throws(() =>
    validateConfig({
      participants: [
        { id: "h1", name: "H1", adapter: "human", enabled: true },
        { id: "h2", name: "H2", adapter: "human", enabled: true },
      ],
    })
  );
});

// ---------------------------------------------------------------------------
// human adapter: strict skip semantics
// ---------------------------------------------------------------------------

test("human speak() only skips on literal skip === true", async () => {
  // A truthy-but-not-true skip with no text is treated as a pass (malformed
  // outcome), never as an utterance; and it must not crash.
  const bridge = { wait: async () => /** @type {any} */ ({ skip: 1 }) };
  const { speak } = makeHuman(bridge);
  const result = await speak(makeCtx({ participant: { id: "you", name: "あなた", adapter: "human" } }));
  assert.equal(result.pass, true);
  assert.equal(result.utterance, "");
});

test("human speak() prefers text when skip is not literally true", async () => {
  const bridge = { wait: async () => /** @type {any} */ ({ skip: 0, text: "発言します" }) };
  const { speak } = makeHuman(bridge);
  const result = await speak(makeCtx({ participant: { id: "you", name: "あなた", adapter: "human" } }));
  assert.equal(result.utterance, "発言します");
  assert.equal(result.pass, false);
});

// ---------------------------------------------------------------------------
// util: endpoint normalization
// ---------------------------------------------------------------------------

test("normalizeEndpoint strips trailing slashes only", () => {
  assert.equal(normalizeEndpoint("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
  assert.equal(normalizeEndpoint("http://127.0.0.1:11434///"), "http://127.0.0.1:11434");
  assert.equal(normalizeEndpoint("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(normalizeEndpoint("http://host/base/path/"), "http://host/base/path");
});

// ---------------------------------------------------------------------------
// util: runProcess timeout / kill / output-cap behavior (real short-lived
// node child processes; no external CLIs)
// ---------------------------------------------------------------------------

test("runProcess resolves with timedOut when the child outlives the timeout", async () => {
  const started = Date.now();
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000);"],
    timeoutMs: 300,
  });
  assert.equal(result.timedOut, true);
  // Must resolve promptly (kill or grace timer), never hang.
  assert.ok(Date.now() - started < 10_000);
});

test("runProcess caps runaway output and surfaces an error", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("x".repeat(3 * 1024 * 1024));'],
    timeoutMs: 30_000,
  });
  assert.ok(result.spawnError, "expected an output-limit error");
  assert.match(String(result.spawnError.message), /exceeded/);
  assert.ok(result.stdout.length <= MAX_OUTPUT_BYTES);
});

test("runProcess survives a child that exits before stdin is consumed (EPIPE)", async () => {
  // Large input into an immediately-exiting child; without stdin error
  // handlers this can crash the whole process with an uncaught EPIPE.
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "process.exit(0);"],
    input: "y".repeat(1024 * 1024),
    timeoutMs: 30_000,
  });
  assert.equal(result.timedOut, false);
  // Either a clean exit or an EPIPE-ish spawn error is fine; the contract is
  // simply that the promise resolves and nothing throws.
  assert.ok(result.code === 0 || result.spawnError);
});

test("runProcess resolves with spawnError for a nonexistent command", async () => {
  const result = await runProcess({
    command: "definitely-not-a-real-command-debate-board",
    args: [],
    timeoutMs: 5_000,
  });
  assert.ok(result.spawnError);
});

// ---------------------------------------------------------------------------
// util: temp dir helpers + adapter temp cleanup on failure
// ---------------------------------------------------------------------------

test("removeDirQuietly removes a dir and never throws", () => {
  const dir = makeTempDir("debate-board-testrm-");
  assert.ok(fs.existsSync(dir));
  removeDirQuietly(dir);
  assert.ok(!fs.existsSync(dir));
  // Second call (already gone) and garbage input must not throw.
  removeDirQuietly(dir);
  removeDirQuietly(null);
});

function countTempDirs(prefix) {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix)).length;
}

test("codex speak() cleans up its temp dirs even when spawn fails", async () => {
  const before = countTempDirs("debate-board-codex-");
  const oldPath = process.env.PATH;
  process.env.PATH = ""; // force ENOENT without touching any real CLI
  try {
    const result = await codexSpeak(makeCtx({ participant: { id: "aki", name: "アキ", adapter: "codex" } }));
    assert.equal(result.pass, true);
    assert.notEqual(result.error, null);
  } finally {
    process.env.PATH = oldPath;
  }
  assert.equal(countTempDirs("debate-board-codex-"), before);
});

test("grok speak() cleans up its temp dirs even when spawn fails", async () => {
  const before = countTempDirs("debate-board-grok-");
  const oldPath = process.env.PATH;
  process.env.PATH = ""; // force ENOENT without touching any real CLI
  try {
    const result = await grokSpeak(makeCtx({ participant: { id: "roki", name: "ロキ", adapter: "grok", persona: "x" } }));
    assert.equal(result.pass, true);
    assert.notEqual(result.error, null);
  } finally {
    process.env.PATH = oldPath;
  }
  assert.equal(countTempDirs("debate-board-grok-"), before);
});

// ---------------------------------------------------------------------------
// adapters never throw, even on malformed ctx (outer try/catch guard)
// ---------------------------------------------------------------------------

test("speak() returns failResult instead of throwing on malformed ctx", async () => {
  for (const speak of [codexSpeak, grokSpeak, ollamaSpeak, oaiSpeak]) {
    const result = await speak(/** @type {any} */ (null));
    assert.equal(result.pass, true);
    assert.notEqual(result.error, null);
  }
});
