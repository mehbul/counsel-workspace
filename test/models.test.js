const { test } = require("node:test");
const assert = require("node:assert/strict");
const { modelConfiguration, generate } = require("../models");
const { profileConfiguration } = require("../models");
test("evidence mode needs no model credentials and invalid endpoint configuration fails closed", () => {
  assert.equal(modelConfiguration({}).enabled, false);
  assert.equal(
    modelConfiguration({ OPENAI_API_KEY: "must-not-trigger-usage" }).enabled,
    false,
  );
  assert.equal(
    modelConfiguration({ AI_PROVIDER: "evidence", OPENAI_API_KEY: "ignored" })
      .enabled,
    false,
  );
  assert.equal(modelConfiguration({ AI_PROVIDER: "ollama" }).enabled, false);
  assert.equal(
    modelConfiguration({
      AI_PROVIDER: "openai-compatible",
      AI_MODEL: "test",
      AI_BASE_URL: "http://remote.example",
    }).enabled,
    false,
  );
});
test("native Anthropic separates system messages, applies budgets and returns only normalized usage", async () => {
  const config = profileConfiguration({
    provider: "anthropic",
    model: "explicit-model",
    apiKey: "secret",
    contextTokens: 8000,
    maxOutputTokens: 256,
  });
  const result = await generate(
    [
      { role: "system", content: "Use evidence." },
      { role: "user", content: "Question" },
    ],
    {
      config,
      fetch: async (url, init) => {
        assert.equal(url, "https://api.anthropic.com/v1/messages");
        assert.equal(init.headers["x-api-key"], "secret");
        assert.equal(init.headers.Authorization, undefined);
        const body = JSON.parse(init.body);
        assert.equal(body.system, "Use evidence.");
        assert.equal(body.messages.length, 1);
        assert.equal(body.max_tokens, 256);
        return Response.json({
          content: [{ type: "text", text: "Answer" }],
          usage: { input_tokens: 25, output_tokens: 3, private: "ignore" },
        });
      },
    },
  );
  assert.equal(result.text, "Answer");
  assert.equal(result.model, "explicit-model");
  assert.equal(result.usage.inputTokens, 25);
  assert.equal(result.usage.outputTokens, 3);
  assert.equal(result.usage.private, undefined);
});
test("over-budget and aborted requests never invoke provider; in-flight cancellation propagates", async () => {
  const config = profileConfiguration({
    provider: "openai",
    model: "test",
    apiKey: "secret",
    contextTokens: 1024,
    maxOutputTokens: 64,
  });
  await assert.rejects(
    generate([{ role: "user", content: "x".repeat(1024) }], {
      config,
      fetch: async () => {
        throw Error("must not call");
      },
    }),
    /context budget/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    generate([], {
      config,
      signal: controller.signal,
      fetch: async () => {
        throw Error("must not call");
      },
    }),
    { name: "AbortError" },
  );
  const active = new AbortController();
  const pending = generate([], {
    config,
    signal: active.signal,
    fetch: async (url, init) =>
      new Promise((resolve, reject) =>
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason),
          { once: true },
        ),
      ),
  });
  active.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
test("local Ollama uses its native non-streaming API without provider credentials", async () => {
  const result = await generate(
    [{ role: "user", content: "Source-grounded test" }],
    {
      env: { AI_PROVIDER: "ollama", OLLAMA_MODEL: "installed-test-model" },
      fetch: async (url, init) => {
        assert.equal(url, "http://127.0.0.1:11434/api/chat");
        assert.ok(!init.headers.Authorization);
        const body = JSON.parse(init.body);
        assert.equal(body.stream, false);
        assert.equal(body.model, "installed-test-model");
        return Response.json({ message: { content: "Local output" } });
      },
    },
  );
  assert.equal(result.text, "Local output");
  assert.equal(result.mode, "Local model analysis");
});
test("compatible endpoints support local or remote servers and sanitize provider failures", async () => {
  const env = {
    AI_PROVIDER: "openai-compatible",
    AI_BASE_URL: "https://provider.example/v1",
    AI_MODEL: "user-selected-model",
    AI_API_KEY: "test-private-key",
  };
  const result = await generate([{ role: "user", content: "Test" }], {
    env,
    fetch: async (url, init) => {
      assert.equal(url, "https://provider.example/v1/chat/completions");
      assert.equal(init.headers.Authorization, "Bearer test-private-key");
      return Response.json({
        choices: [{ message: { content: "Compatible response" } }],
      });
    },
  });
  assert.equal(result.text, "Compatible response");
  await assert.rejects(
    generate([], {
      env,
      fetch: async () =>
        Response.json({ error: "secret provider details" }, { status: 401 }),
    }),
    (e) => !e.message.includes("secret provider details"),
  );
});
test("OpenAI response parsing remains compatible and invalid model outputs fail explicitly", async () => {
  const env = { AI_PROVIDER: "openai", OPENAI_API_KEY: "test-key" };
  const r = await generate([], {
    env,
    fetch: async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(JSON.parse(init.body).store, false);
      return Response.json({
        output: [
          { content: [{ type: "output_text", text: "Existing response" }] },
        ],
      });
    },
  });
  assert.equal(r.text, "Existing response");
  await assert.rejects(
    generate([], { env, fetch: async () => Response.json({ output: [] }) }),
    /no text/,
  );
});
