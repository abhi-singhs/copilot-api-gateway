#!/usr/bin/env node
/**
 * Model matrix smoke test.
 *
 * Point it at a running gateway:
 *
 *   COPILOT_API_MASTER_KEY=... npm run test:models
 *   TEST_BASE=http://127.0.0.1:4000 npm run test:models
 *
 * It checks, per model family, that the gateway still routes correctly and
 * that translation holds:
 *
 *   - `/v1/models` advertises only models that upstream actually serves
 *   - non-streaming chat completion
 *   - streaming chat completion (chunks + [DONE])
 *   - tool calling (with `tool_choice: "required"` so it is deterministic)
 *   - Anthropic `/v1/messages` translation
 *   - responses-only models are bridged transparently
 *
 * Exits non-zero when any check fails, so catalog drift is caught in CI.
 */

const BASE = process.env.TEST_BASE ?? "http://127.0.0.1:4000";
const KEY = process.env.COPILOT_API_MASTER_KEY ?? "";
const H = {
  "content-type": "application/json",
  ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
};

// One representative per routing/vendor path. Override with
// TEST_MODELS="a,b,c" to test a different set.
const DEFAULT_MODELS = [
  "claude-sonnet-4.6", // Anthropic, /chat/completions
  "gemini-3.5-flash", // Google, /chat/completions
  "gpt-5.4", // OpenAI, /chat/completions + max_completion_tokens shaping
  "gpt-5.5", // OpenAI, responses-only bridge
  "grok-4.5", // xAI, responses-only bridge
];

const MODELS = (process.env.TEST_MODELS ?? DEFAULT_MODELS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const results = [];
const record = (model, check, ok, detail = "") => {
  results.push({ model, check, ok, detail });
  const tag = ok ? "\u001b[32mPASS\u001b[0m" : "\u001b[31mFAIL\u001b[0m";
  console.log(`  ${tag} ${check}${detail ? ` :: ${detail}` : ""}`);
};

const TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

const post = (path, body) =>
  fetch(BASE + path, { method: "POST", headers: H, body: JSON.stringify(body) });

const catalogCheck = async () => {
  console.log("\n/v1/models");
  let r;
  try {
    r = await fetch(BASE + "/v1/models", { headers: H });
  } catch (err) {
    record("-", "models endpoint", false, `gateway unreachable at ${BASE}`);
    throw err;
  }
  if (!r.ok) {
    record("-", "models endpoint", false, `HTTP ${r.status}`);
    return new Set();
  }
  const j = await r.json();
  const ids = new Set((j.data ?? []).map((m) => m.id));
  record("-", "models endpoint", ids.size > 0, `${ids.size} models`);

  // Anything advertised must be callable; embeddings models are not.
  const embeddings = [...ids].filter((id) => id.includes("embedding"));
  record(
    "-",
    "no non-chat models advertised",
    embeddings.length === 0,
    embeddings.join(",") || "none",
  );
  return ids;
};

const chat = async (model) => {
  const r = await post("/v1/chat/completions", {
    model,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    max_tokens: 16000,
  });
  const txt = await r.text();
  if (r.status !== 200) {
    return record(model, "chat", false, `HTTP ${r.status} ${txt.slice(0, 90)}`);
  }
  const content = JSON.parse(txt).choices?.[0]?.message?.content ?? "";
  record(model, "chat", Boolean(content), JSON.stringify(content).slice(0, 40));
};

const streaming = async (model) => {
  const r = await post("/v1/chat/completions", {
    model,
    messages: [{ role: "user", content: "Count 1 to 3" }],
    max_tokens: 16000,
    stream: true,
  });
  if (r.status !== 200) {
    return record(model, "stream", false, `HTTP ${r.status} ${(await r.text()).slice(0, 90)}`);
  }
  const txt = await new Response(r.body).text();
  const chunks = txt
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
  const done = txt.includes("[DONE]");
  record(model, "stream", chunks.length > 0 && done, `${chunks.length} chunks, DONE=${done}`);
};

const tools = async (model) => {
  const r = await post("/v1/chat/completions", {
    model,
    messages: [{ role: "user", content: "Weather in Paris?" }],
    max_tokens: 16000,
    tools: [TOOL],
    tool_choice: "required",
  });
  const txt = await r.text();
  if (r.status !== 200) {
    return record(model, "tools", false, `HTTP ${r.status} ${txt.slice(0, 90)}`);
  }
  const tc = JSON.parse(txt).choices?.[0]?.message?.tool_calls;
  record(model, "tools", Boolean(tc?.length), tc?.[0]?.function?.name ?? "no tool_calls");
};

const messages = async (model) => {
  const r = await post("/v1/messages", {
    model,
    max_tokens: 2048,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });
  const txt = await r.text();
  if (r.status !== 200) {
    return record(model, "messages", false, `HTTP ${r.status} ${txt.slice(0, 90)}`);
  }
  const text = (JSON.parse(txt).content ?? []).map((b) => b.text ?? "").join("");
  record(model, "messages", Boolean(text), JSON.stringify(text).slice(0, 40));
};

const main = async () => {
  console.log(`gateway: ${BASE}`);
  if (!KEY) console.log("warning: COPILOT_API_MASTER_KEY not set");

  const ids = await catalogCheck();

  for (const model of MODELS) {
    console.log(`\n${model}`);
    if (ids.size > 0 && !ids.has(model)) {
      record(model, "advertised in /v1/models", false, "missing from catalog");
    }
    await chat(model);
    await streaming(model);
    await tools(model);
    await messages(model);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAILED ${f.model} ${f.check} ${f.detail}`);
    process.exit(1);
  }
};

main().catch((err) => {
  console.error("smoke test failed:", err.message);
  process.exit(1);
});
