const { test } = require("node:test");
const assert = require("node:assert/strict");
const { modelConfiguration, generate } = require("../models");
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
