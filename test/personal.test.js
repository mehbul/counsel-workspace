const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { WebSocket } = require("ws");
const { createPersonalMode } = require("../personal");
process.env.COUNSEL_PERSONAL = "true";
process.env.COUNSEL_DB = ":memory:";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "counsel-personal-"),
);
process.env.HOST = "127.0.0.1";
process.env.COOKIE_SECURE = "false";
process.env.NODE_ENV = "test";
process.env.AI_PROVIDER = "evidence";
delete process.env.APP_ORIGIN;
delete process.env.TRUST_PROXY;
const {
  db,
  jobs,
  workflows,
  createServer,
  collaboration,
} = require("../server");
const initial = () => ({
  matters: [],
  documents: [],
  messages: [],
  reviews: [],
  drafts: [],
  tasks: [],
  skills: [],
  activity: [],
});
const personalEnv = {
  COUNSEL_PERSONAL: "true",
  HOST: "127.0.0.1",
  COOKIE_SECURE: "false",
};

function emptyDatabase() {
  const fixture = new DatabaseSync(":memory:");
  fixture.exec(`CREATE TABLE state(id INTEGER PRIMARY KEY,value TEXT);
    CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,password TEXT,workspace_id TEXT,role TEXT,disabled INTEGER);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT,value TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);`);
  return fixture;
}
test("personal mode preflights configuration and refuses any unmarked team or legacy data", () => {
  for (const change of [
    { HOST: "0.0.0.0" },
    { HOST: "192.168.1.2" },
    { HOST: "example.test" },
    { NODE_ENV: "production" },
    { TRUST_PROXY: "1" },
    { COOKIE_SECURE: "true" },
    { APP_ORIGIN: "https://example.test" },
    { APP_ORIGIN: "http://127.1:3000" },
  ]) {
    const fixture = emptyDatabase();
    const before = fixture
      .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
      .all();
    assert.throws(
      () => createPersonalMode(fixture, { ...personalEnv, ...change }),
      /Personal mode/,
    );
    assert.deepEqual(
      fixture.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
      before,
    );
    fixture.close();
  }
  for (const record of [
    "INSERT INTO users VALUES('owner','team@example.test','existing-hash','team','owner',0)",
    "INSERT INTO workspaces VALUES('team','Team','{\"confidential\":true}')",
    'INSERT INTO state VALUES(1,\'{"legacyDocuments":["confidential"]}\')',
    "INSERT INTO settings VALUES('bootstrap','existing-team-setup')",
  ]) {
    const fixture = emptyDatabase();
    fixture.exec(record);
    assert.throws(
      () => createPersonalMode(fixture, personalEnv),
      /existing team or legacy database/,
    );
    assert.equal(
      fixture
        .prepare("SELECT 1 FROM sqlite_master WHERE name='personal_database'")
        .get(),
      undefined,
    );
    assert.equal(createPersonalMode(fixture, {}), null);
    fixture.close();
  }
});
test("personal database identity is persistent and cannot silently become a team", () => {
  const fixture = emptyDatabase();
  let seeds = 0;
  const mode = createPersonalMode(fixture, personalEnv);
  const owner = mode.initialize(() => {
    seeds++;
    return initial();
  });
  assert.equal(owner.role, "owner");
  assert.equal(owner.email, "personal@localhost.invalid");
  const restarted = createPersonalMode(fixture, personalEnv);
  assert.equal(
    restarted.initialize(() => {
      seeds++;
      return initial();
    }).id,
    owner.id,
  );
  assert.equal(seeds, 1);
  fixture
    .prepare("INSERT INTO users VALUES(?,?,?,?,?,0)")
    .run("someone", "other@team.test", "hash", owner.workspace_id, "editor");
  assert.throws(
    () => createPersonalMode(fixture, personalEnv),
    /identity changed/,
  );
  fixture.prepare("DELETE FROM users WHERE id='someone'").run();
  fixture.prepare("UPDATE users SET disabled=1 WHERE id=?").run(owner.id);
  assert.throws(
    () => createPersonalMode(fixture, personalEnv),
    /identity changed/,
  );
  fixture.close();
});
test("personal request guard rejects proxies, rebinding and foreign peers for every method", () => {
  const fixture = emptyDatabase();
  const mode = createPersonalMode(fixture, personalEnv);
  const request = (headers = {}, remoteAddress = "127.0.0.1") => ({
    headers: { host: "127.0.0.1:3000", ...headers },
    socket: { remoteAddress },
  });
  assert.equal(mode.validateRequest(request()), true);
  assert.equal(
    mode.validateRequest(
      request({
        origin: "http://127.0.0.1:3000",
        "sec-fetch-site": "same-origin",
      }),
    ),
    true,
  );
  assert.equal(
    mode.validateRequest(
      request({ host: "[::1]:3000", origin: "http://[::1]:3000" }, "::1"),
    ),
    true,
  );
  assert.equal(
    mode.validateRequest(
      request({ host: "localhost:3000" }, "::ffff:127.0.0.1"),
    ),
    true,
  );
  for (const headers of [
    { host: "evil.test:3000" },
    { host: "127.0.0.1.evil.test:3000" },
    { host: "127.1:3000" },
    { host: "2130706433:3000" },
    { host: "0x7f000001:3000" },
    { host: "localhost:99999" },
    { host: "localhost:3000/path" },
    { origin: "https://evil.test" },
    { origin: "null" },
    { origin: "http://127.0.0.1:3001" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { forwarded: "for=127.0.0.1" },
    { "x-forwarded-for": "127.0.0.1" },
    { "X-Forwarded-Proto": "http" },
    { "x-forwarded-host": "127.0.0.1:3000" },
    { "x-real-ip": "127.0.0.1" },
    { via: "proxy" },
  ])
    assert.equal(
      mode.validateRequest(request(headers)),
      false,
      JSON.stringify(headers),
    );
  assert.equal(mode.validateRequest(request({}, "192.168.1.2")), false);
  assert.equal(
    mode.validateRequest({ headers: { host: "localhost:3000" } }),
    false,
  );
  const pinned = createPersonalMode(fixture, {
    ...personalEnv,
    APP_ORIGIN: "http://localhost:3000",
  });
  assert.equal(
    pinned.validateRequest(request({ host: "localhost:3000" })),
    true,
  );
  assert.equal(pinned.validateRequest(request()), false);
  fixture.close();
});
test("personal UI sessions need no login while API writes and collaboration retain protections", async (t) => {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port,
    origin = `http://127.0.0.1:${port}`;
  let cookie = "",
    csrf = "",
    draft;
  async function request(route, body, extraHeaders = {}) {
    const response = await fetch(origin + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie").split(";")[0];
    const data = response.headers
      .get("content-type")
      ?.includes("application/json")
      ? await response.json()
      : await response.text();
    if (data.csrf) csrf = data.csrf;
    return { status: response.status, data };
  }
  async function raw(route, headers) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: route,
          method: "GET",
          headers: { Host: `127.0.0.1:${port}`, ...headers },
        },
        (response) => {
          response.resume();
          response.once("end", () =>
            resolve({
              status: response.statusCode,
              setCookie: response.headers["set-cookie"],
            }),
          );
        },
      );
      req.once("error", reject);
      req.end();
    });
  }
  try {
    await t.test(
      "opening auth/me issues an owner session without setup or a password",
      async () => {
        assert.equal((await request("/api/state")).status, 401);
        const session = await request("/api/auth/me");
        assert.equal(session.status, 200);
        assert.equal(session.data.personal, true);
        assert.equal(session.data.user.role, "owner");
        assert.ok(cookie);
        assert.ok(csrf);
        assert.equal((await request("/api/state")).status, 200);
        assert.equal(
          fs.existsSync(path.join(process.env.DATA_DIR, "bootstrap-token")),
          false,
        );
        assert.equal(db.prepare("SELECT COUNT(*) n FROM users").get().n, 1);
        assert.equal((await request("/api/auth/setup", {})).status, 403);
        assert.equal((await request("/api/auth/login", {})).status, 403);
        assert.equal((await request("/api/auth/password", {})).status, 403);
      },
    );
    await t.test(
      "CSRF remains required and team account or client-publication routes are disabled",
      async () => {
        assert.equal(
          (
            await request(
              "/api/matters",
              { name: "No CSRF" },
              { "X-CSRF-Token": "" },
            )
          ).status,
          403,
        );
        assert.equal(
          (await request("/api/matters", { name: "Personal matter" })).status,
          200,
        );
        assert.equal((await request("/api/admin/users")).status, 403);
        assert.equal(
          (
            await request("/api/admin/users", {
              email: "other@example.test",
              role: "guest",
              password: "Should never be created",
            })
          ).status,
          403,
        );
        assert.equal((await request("/api/admin/access", {})).status, 403);
        assert.equal((await request("/api/portal/manage")).status, 403);
        assert.equal((await request("/api/portal/manage", {})).status, 403);
      },
    );
    await t.test(
      "HTTP guard applies before static files, automatic sessions and agent endpoints",
      async () => {
        for (const route of [
          "/",
          "/portal.html",
          "/api/auth/me",
          "/health/ready",
          "/agent/v1/list_matters",
        ])
          for (const headers of [
            { Host: "evil.test" },
            { Origin: "https://evil.test" },
            { "X-Forwarded-For": "127.0.0.1" },
            { "Sec-Fetch-Site": "cross-site" },
          ]) {
            const result = await raw(route, headers);
            assert.equal(result.status, 403, route + JSON.stringify(headers));
            assert.equal(result.setCookie, undefined);
          }
      },
    );
    await t.test(
      "shared editing works locally and rejects foreign origins and forwarded websocket handshakes",
      async () => {
        const state = (await request("/api/state")).data;
        draft = (
          await request("/api/drafts", {
            matterId: state.matters[0].id,
            title: "Personal editing",
            prompt: "Governing law",
          })
        ).data;
        async function socket(headers, permitted) {
          return new Promise((resolve, reject) => {
            const ws = new WebSocket(
              origin.replace("http:", "ws:") +
                "/collaboration?draft=" +
                draft.id,
              { headers: { Cookie: cookie, Origin: origin, ...headers } },
            );
            const timer = setTimeout(() => {
              ws.terminate();
              reject(Error("WebSocket check timed out"));
            }, 4000);
            ws.on("message", (data) => {
              if (!permitted) {
                clearTimeout(timer);
                ws.terminate();
                reject(Error("Rejected request opened a socket"));
                return;
              }
              const message = JSON.parse(data);
              if (message.type === "sync") {
                clearTimeout(timer);
                ws.close();
                resolve(message);
              }
            });
            ws.on("error", (error) => {
              clearTimeout(timer);
              permitted ? reject(error) : resolve();
            });
          });
        }
        assert.equal((await socket({}, true)).readOnly, false);
        await socket({ Origin: "http://localhost:9999" }, false);
        await socket({ "X-Forwarded-For": "127.0.0.1" }, false);
        await socket({ Host: "evil.test" }, false);
      },
    );
    await t.test(
      "logout revokes the session and the next local open creates a fresh one",
      async () => {
        const previous = cookie;
        assert.equal((await request("/api/auth/logout", {})).status, 200);
        assert.equal((await request("/api/state")).status, 401);
        assert.equal((await request("/api/auth/me")).data.personal, true);
        assert.notEqual(cookie, previous);
        assert.equal((await request("/api/state")).status, 200);
      },
    );
  } finally {
    await workflows.close();
    await jobs.close();
    collaboration.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
});
test("ordinary team mode still requires login", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "counsel-team-login-"),
  );
  const fixture = emptyDatabase(),
    app = express();
  app.use(express.json());
  const previous = {
    COUNSEL_PERSONAL: process.env.COUNSEL_PERSONAL,
    DATA_DIR: process.env.DATA_DIR,
  };
  process.env.COUNSEL_PERSONAL = "false";
  process.env.DATA_DIR = directory;
  const security = require("../security").installSecurity(
    app,
    fixture,
    initial,
  );
  process.env.COUNSEL_PERSONAL = previous.COUNSEL_PERSONAL;
  process.env.DATA_DIR = previous.DATA_DIR;
  app.get("/api/protected", (req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    assert.equal(security.personal, null);
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(origin + "/api/protected")).status, 401);
    const identity = await (await fetch(origin + "/api/auth/me")).json();
    assert.equal(identity.user, null);
    assert.equal(identity.setupRequired, true);
    assert.ok(fs.existsSync(path.join(directory, "bootstrap-token")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
