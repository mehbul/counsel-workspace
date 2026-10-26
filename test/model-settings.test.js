const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const { context } = require("../security");
const { createModelSettings, endpointAddresses } = require("../model-settings");
test("real settings routes enforce owner/workspace boundaries, encrypt keys and only explicitly test providers", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-settings-"));
  const db = new DatabaseSync(":memory:"),
    app = express();
  let calls = 0;
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = {
      id: "user",
      role: req.get("x-role") || "owner",
      workspace_id: req.get("x-workspace") || "a",
    };
    context.run({ workspaceId: req.user.workspace_id }, next);
  });
  createModelSettings(
    app,
    db,
    { audit() {} },
    {
      dataDir: directory,
      env: {},
      fetch: async (url, init) => {
        calls++;
        assert.equal(url, "https://api.anthropic.com/v1/messages");
        assert.equal(init.headers["x-api-key"], "private-key");
        return Response.json({
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 8, output_tokens: 1 },
        });
      },
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/api/model-settings`;
  const request = (method, body, headers = {}) =>
    fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body && JSON.stringify(body),
    });
  assert.equal(
    (await request("GET", null, { "x-role": "member" })).status,
    403,
  );
  const profile = {
    provider: "anthropic",
    model: "test",
    apiKey: "private-key",
    contextTokens: 8000,
    maxOutputTokens: 100,
  };
  let response = await request("PUT", profile);
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.hasKey, true);
  assert.equal(saved.apiKey, undefined);
  assert.equal(calls, 0);
  assert.ok(
    !db
      .prepare("SELECT config FROM model_settings")
      .get()
      .config.includes("private-key"),
  );
  assert.equal(
    (await (await request("GET", null, { "x-workspace": "b" })).json())
      .provider,
    "evidence",
  );
  response = await fetch(url + "/test", { method: "POST" });
  assert.equal(response.status, 200);
  const tested = await response.json();
  assert.equal(tested.usage.inputTokens, 8);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(tested).includes("private-key"));
  const { apiKey, ...retained } = profile;
  assert.equal((await request("PUT", retained)).status, 200);
  assert.equal(calls, 1);
  assert.equal(
    (await request("PUT", { ...profile, maxOutputTokens: 9000 })).status,
    400,
  );
  assert.equal(
    (await request("PUT", { provider: "ollama", model: "test" })).status,
    400,
  );
  assert.equal((await request("DELETE")).status, 200);
  assert.equal((await (await request("GET")).json()).provider, "evidence");
});
test("endpoint checks reject private, metadata, IPv4-mapped and mixed DNS answers; local is operator opt-in", async () => {
  for (const host of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "192.168.1.1",
    "100.64.0.1",
  ])
    await assert.rejects(endpointAddresses(new URL("https://" + host), {}));
  await endpointAddresses(new URL("http://127.0.0.1:11434"), {
    COUNSEL_PERSONAL: "true",
  });
  await endpointAddresses(new URL("http://[::1]:11434"), {
    MODEL_ALLOW_LOOPBACK: "true",
  });
  await assert.rejects(
    endpointAddresses(new URL("https://provider.example"), {}, async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]),
  );
});
