const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { WebSocket } = require("ws");
process.env.COUNSEL_DB = ":memory:";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "counsel-security-regression-"),
);
process.env.AI_PROVIDER = "evidence";
const {
  createServer,
  db,
  jobs,
  workflows,
  collaboration,
} = require("../server");

test("credential recovery, MCP dispatch and malformed collaboration frames fail closed", async (t) => {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  function client() {
    return {
      cookie: "",
      csrf: "",
      async req(p, b, method = b ? "POST" : "GET") {
        const r = await fetch(origin + "/api/" + p, {
          method,
          headers: {
            Cookie: this.cookie,
            "X-CSRF-Token": this.csrf,
            "Content-Type": "application/json",
          },
          body: b ? JSON.stringify(b) : undefined,
        });
        if (r.headers.get("set-cookie"))
          this.cookie = r.headers.get("set-cookie").split(";")[0];
        const data = await r.json().catch(() => null);
        if (data?.csrf) this.csrf = data.csrf;
        return { status: r.status, data };
      },
    };
  }
  const owner = client(),
    editor = client(),
    viewer = client();
  const agent = async (key, operation = "session") => {
    const r = await fetch(origin + "/agent/v1/" + operation, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    await owner.req("auth/setup", {
      token: fs.readFileSync(
        path.join(process.env.DATA_DIR, "bootstrap-token"),
        "utf8",
      ),
      email: "owner@regression.test",
      password: "Original security regression passphrase",
      workspace: "Security regressions",
    });
    const mid = (await owner.req("state")).data.matters[0].id;
    const key = (
      await owner.req("agent-tokens", {
        name: "Owner connection",
        matterIds: [mid],
      })
    ).data.token;
    await t.test(
      "prototype operation names are rejected as unknown operations",
      async () => {
        for (const operation of [
          "constructor",
          "__proto__",
          "toString",
          "hasOwnProperty",
        ])
          assert.equal((await agent(key, operation)).status, 404, operation);
      },
    );
    await t.test(
      "password changes revoke all assistant keys as well as old sessions",
      async () => {
        assert.equal((await agent(key)).status, 200);
        const changed = await owner.req("auth/password", {
          currentPassword: "Original security regression passphrase",
          password: "Replacement security regression passphrase",
        });
        assert.equal(changed.status, 200);
        assert.equal((await agent(key)).status, 401);
        assert.equal((await owner.req("state")).status, 200);
      },
    );
    async function duringPasswordHash(password, request) {
      const argon2 = require("argon2"),
        original = argon2.hash;
      let entered, release;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      argon2.hash = async (value, ...args) => {
        const encoded = await original(value, ...args);
        if (value === password) {
          entered();
          await blocked;
        }
        return encoded;
      };
      let pending;
      try {
        pending = request();
        await started;
        assert.equal((await owner.req("auth/logout", {})).status, 200);
        release();
        return await pending;
      } finally {
        release();
        argon2.hash = original;
        await pending?.catch(() => {});
        await owner.req("auth/login", {
          email: "owner@regression.test",
          password: "Replacement security regression passphrase",
        });
      }
    }
    await t.test(
      "logout during password hashing cannot create a new session or change the password",
      async () => {
        const response = await duringPasswordHash(
          "Racing security regression passphrase",
          () =>
            owner.req("auth/password", {
              currentPassword: "Replacement security regression passphrase",
              password: "Racing security regression passphrase",
            }),
        );
        assert.equal(response.status, 401);
        assert.equal((await owner.req("state")).status, 200);
      },
    );
    await t.test(
      "logout during member-password hashing prevents stale owner account creation",
      async () => {
        const response = await duringPasswordHash(
          "Racing member security passphrase",
          () =>
            owner.req("admin/users", {
              email: "must-not-exist@regression.test",
              password: "Racing member security passphrase",
              role: "editor",
            }),
        );
        assert.equal(response.status, 401);
        assert.equal(
          db
            .prepare("SELECT COUNT(*) n FROM users WHERE email=?")
            .get("must-not-exist@regression.test").n,
          0,
        );
      },
    );
    await owner.req("admin/users", {
      email: "editor@regression.test",
      password: "Editor security regression passphrase",
      role: "editor",
    });
    await owner.req("admin/users", {
      email: "viewer@regression.test",
      password: "Viewer security regression passphrase",
      role: "viewer",
    });
    const users = (await owner.req("admin/users")).data,
      eid = users.find((u) => u.role === "editor").id,
      vid = users.find((u) => u.role === "viewer").id;
    await owner.req("admin/access", {
      userId: eid,
      matterId: mid,
      allowed: true,
    });
    await owner.req("admin/access", {
      userId: vid,
      matterId: mid,
      allowed: true,
    });
    await editor.req("auth/login", {
      email: "editor@regression.test",
      password: "Editor security regression passphrase",
    });
    const editorKey = (
      await editor.req("agent-tokens", {
        name: "Editor connection",
        matterIds: [mid],
      })
    ).data.token;
    await t.test(
      "disabling and later re-enabling a member does not revive old assistant keys",
      async () => {
        await owner.req("admin/users/" + eid, { disabled: true }, "PATCH");
        assert.equal((await agent(editorKey)).status, 401);
        await owner.req("admin/users/" + eid, { disabled: false }, "PATCH");
        assert.equal((await agent(editorKey)).status, 401);
        await editor.req("auth/login", {
          email: "editor@regression.test",
          password: "Editor security regression passphrase",
        });
        assert.equal((await editor.req("state")).status, 200);
      },
    );
    await t.test(
      "null and primitive websocket frames close only the sender, including a viewer",
      async () => {
        const draft = (
          await owner.req("drafts", {
            matterId: mid,
            title: "Shared test draft",
            prompt: "governing law",
          })
        ).data;
        await viewer.req("auth/login", {
          email: "viewer@regression.test",
          password: "Viewer security regression passphrase",
        });
        for (const payload of ["null", "42", "true", '"message"', "[]"]) {
          const ws = new WebSocket(
            origin.replace("http:", "ws:") + "/collaboration?draft=" + draft.id,
            { headers: { Cookie: viewer.cookie, Origin: origin } },
          );
          try {
            await new Promise((resolve, reject) => {
              ws.once("open", resolve);
              ws.once("error", reject);
            });
            const close = new Promise((resolve, reject) => {
              const timer = setTimeout(
                () => reject(Error("Malformed client was not closed")),
                2000,
              );
              ws.once("close", (code) => {
                clearTimeout(timer);
                resolve(code);
              });
            });
            ws.send(payload);
            assert.equal(await close, 1008);
            assert.equal((await fetch(origin + "/health/ready")).status, 200);
          } finally {
            ws.terminate();
          }
        }
      },
    );
    await t.test(
      "offline password recovery revokes agent keys and sessions atomically",
      async () => {
        const folder = fs.mkdtempSync(
            path.join(os.tmpdir(), "counsel-offline-reset-"),
          ),
          file = path.join(folder, "workspace.db"),
          password = path.join(folder, "password.txt");
        const { DatabaseSync } = require("node:sqlite");
        const offline = new DatabaseSync(file);
        offline.exec(
          "CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,password TEXT); CREATE TABLE sessions(hash TEXT,user_id TEXT); CREATE TABLE agent_tokens(user_id TEXT,revoked INTEGER);",
        );
        offline
          .prepare("INSERT INTO users VALUES(?,?,?)")
          .run("u", "recover@example.test", "old-hash");
        offline.prepare("INSERT INTO sessions VALUES(?,?)").run("session", "u");
        offline.prepare("INSERT INTO agent_tokens VALUES(?,0)").run("u");
        offline.close();
        fs.writeFileSync(password, "Recovered security regression passphrase");
        try {
          const result = spawnSync(
            process.execPath,
            [
              path.resolve("scripts/reset-password.js"),
              "recover@example.test",
              password,
            ],
            { env: { ...process.env, COUNSEL_DB: file }, encoding: "utf8" },
          );
          assert.equal(result.status, 0, result.stderr);
          const verify = new DatabaseSync(file, { readOnly: true });
          try {
            assert.equal(
              verify.prepare("SELECT COUNT(*) n FROM sessions").get().n,
              0,
            );
            assert.equal(
              verify.prepare("SELECT revoked FROM agent_tokens").get().revoked,
              1,
            );
          } finally {
            verify.close();
          }
        } finally {
          fs.rmSync(folder, { recursive: true, force: true });
        }
      },
    );
  } finally {
    collaboration.close();
    await workflows.close();
    await jobs.close();
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
});
