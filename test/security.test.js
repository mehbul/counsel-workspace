const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
process.env.COUNSEL_DB = ":memory:";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "counsel-security-"),
);
const { app, db, jobs } = require("../server");
const argon2 = require("argon2");
test("authentication, workspace boundaries, roles, CSRF, validation and revocation", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  function client() {
    return {
      cookie: "",
      csrf: "",
      async req(p, body, method = body ? "POST" : "GET", extra = {}) {
        const r = await fetch(base + p, {
          method,
          headers: {
            "Content-Type": "application/json",
            Cookie: this.cookie,
            "X-CSRF-Token": this.csrf,
            ...extra,
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (r.headers.get("set-cookie"))
          this.cookie = r.headers.get("set-cookie").split(";")[0];
        const data = await r.json().catch(() => null);
        if (data?.csrf) this.csrf = data.csrf;
        return { status: r.status, data, headers: r.headers };
      },
    };
  }
  const owner = client(),
    viewer = client(),
    editor = client(),
    outsider = client();
  let wid, mid, foreignDraft;
  try {
    await t.test("anonymous APIs fail closed", async () => {
      assert.equal((await owner.req("/api/state")).status, 401);
      assert.equal(
        (await owner.req("/api/matters", { name: "no" })).status,
        401,
      );
      assert.equal((await owner.req("/health/ready")).status, 200);
    });
    await t.test("setup needs local token and is single-use", async () => {
      const b = {
        email: "owner@test.example",
        password: "Owner passphrase with 30 chars",
        workspace: "Owner workspace",
      };
      assert.equal(
        (await owner.req("/api/auth/setup", { ...b, token: "0".repeat(64) }))
          .status,
        403,
      );
      const token = fs.readFileSync(
        path.join(process.env.DATA_DIR, "bootstrap-token"),
        "utf8",
      );
      const r = await owner.req("/api/auth/setup", { ...b, token });
      assert.equal(r.status, 200);
      assert.match(r.headers.get("set-cookie"), /HttpOnly/);
      assert.match(r.headers.get("set-cookie"), /SameSite=Strict/);
      assert.equal(
        (await owner.req("/api/auth/setup", { ...b, token })).status,
        403,
      );
      wid = db
        .prepare("SELECT workspace_id FROM users WHERE email=?")
        .get(b.email).workspace_id;
    });
    await t.test(
      "cross-origin and missing CSRF mutations are rejected",
      async () => {
        assert.equal(
          (
            await owner.req("/api/matters", { name: "bad" }, "POST", {
              "X-CSRF-Token": "",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await owner.req("/api/matters", { name: "bad" }, "POST", {
              Origin: "https://evil.example",
            })
          ).status,
          403,
        );
      },
    );
    await t.test("validated matter writes persist concurrently", async () => {
      assert.equal(
        (await owner.req("/api/matters", { name: { attack: true } })).status,
        400,
      );
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          owner.req("/api/matters", { name: `Concurrent ${i}` }),
        ),
      );
      assert.ok(results.every((r) => r.status === 200));
      const state = (await owner.req("/api/state")).data;
      assert.equal(
        state.matters.filter((m) => m.name.startsWith("Concurrent")).length,
        6,
      );
      mid = results[0].data.id;
    });
    await t.test("owners provision editors and viewers", async () => {
      for (const role of ["editor", "viewer"])
        assert.equal(
          (
            await owner.req("/api/admin/users", {
              email: `${role}@test.example`,
              password: "Member passphrase with 30 chars",
              role,
            })
          ).status,
          200,
        );
      assert.equal(
        (
          await viewer.req("/api/auth/login", {
            email: "viewer@test.example",
            password: "Member passphrase with 30 chars",
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await editor.req("/api/auth/login", {
            email: "editor@test.example",
            password: "Member passphrase with 30 chars",
          })
        ).status,
        200,
      );
      assert.equal((await viewer.req("/api/state")).status, 200);
      assert.equal(
        (await viewer.req("/api/matters", { name: "blocked" })).status,
        403,
      );
      assert.equal((await editor.req("/api/admin/users")).status, 403);
      assert.equal(
        (await editor.req("/api/matters", { name: "Editor matter" })).status,
        200,
      );
    });
    await t.test(
      "matter grants filter reads and writes, and revocation takes effect immediately",
      async () => {
        const users = (await owner.req("/api/admin/users")).data;
        const ed = users.find((u) => u.role === "editor");
        assert.ok(
          !(await editor.req("/api/state")).data.matters.some(
            (m) => m.id === mid,
          ),
        );
        assert.equal(
          (
            await editor.req("/api/tasks", {
              matterId: mid,
              title: "No access",
            })
          ).status,
          404,
        );
        await owner.req("/api/admin/access", {
          userId: ed.id,
          matterId: mid,
          allowed: true,
        });
        assert.ok(
          (await editor.req("/api/state")).data.matters.some(
            (m) => m.id === mid,
          ),
        );
        assert.equal(
          (
            await editor.req("/api/tasks", {
              matterId: mid,
              title: "Authorized task",
            })
          ).status,
          200,
        );
        await owner.req("/api/admin/access", {
          userId: ed.id,
          matterId: mid,
          allowed: false,
        });
        assert.ok(
          !(await editor.req("/api/state")).data.tasks.some(
            (t) => t.title === "Authorized task",
          ),
        );
        assert.ok(
          (await owner.req("/api/state")).data.tasks.some(
            (t) => t.title === "Authorized task",
          ),
        );
      },
    );
    await t.test(
      "foreign workspace identifiers cannot read or change records",
      async () => {
        const w = randomUUID(),
          u = randomUUID(),
          d = randomUUID();
        const foreign = {
          matters: [{ id: randomUUID(), name: "Secret matter" }],
          documents: [],
          messages: [],
          reviews: [],
          drafts: [{ id: d, title: "Secret draft", content: "Never exposed" }],
          tasks: [],
          skills: [],
          activity: [],
        };
        db.prepare("INSERT INTO workspaces VALUES(?,?,?)").run(
          w,
          "Other organization",
          JSON.stringify(foreign),
        );
        db.prepare("INSERT INTO users VALUES(?,?,?,?,?,0)").run(
          u,
          "outside@test.example",
          await argon2.hash("Outside passphrase with 30 chars"),
          w,
          "owner",
        );
        await outsider.req("/api/auth/login", {
          email: "outside@test.example",
          password: "Outside passphrase with 30 chars",
        });
        const state = (await outsider.req("/api/state")).data;
        assert.equal(state.matters.length, 1);
        assert.equal(state.matters[0].name, "Secret matter");
        assert.equal(
          (
            await outsider.req("/api/tasks", {
              matterId: mid,
              title: "Injected",
            })
          ).status,
          404,
        );
        assert.equal(
          (await owner.req("/api/drafts/" + d, undefined, "GET")).status,
          404,
        );
        assert.equal(
          (await owner.req("/api/drafts/" + d + "/export")).status,
          404,
        );
        assert.equal(
          (
            await owner.req(
              "/api/drafts/" + d,
              { content: "overwrite" },
              "PATCH",
            )
          ).status,
          404,
        );
      },
    );
    await t.test(
      "durable review run completes once with persisted output and restricted status access",
      async () => {
        const r = await owner.req(
          "/api/reviews",
          { matterId: mid, name: "Durable review", columns: ["Governing law"] },
          "POST",
          { Prefer: "respond-async" },
        );
        assert.equal(r.status, 202);
        await jobs.tick();
        const result = await owner.req("/api/jobs/" + r.data.jobId);
        assert.equal(result.data.status, "completed");
        assert.equal(result.data.result.id, r.data.jobId);
        assert.equal(
          (await outsider.req("/api/jobs/" + r.data.jobId)).status,
          404,
        );
        db.prepare(
          "UPDATE jobs SET status='queued',result=NULL WHERE id=?",
        ).run(r.data.jobId);
        await jobs.tick();
        assert.equal(
          (await owner.req("/api/state")).data.reviews.filter(
            (x) => x.id === r.data.jobId,
          ).length,
          1,
        );
      },
    );
    await t.test(
      "disabled member loses existing session immediately",
      async () => {
        const users = (await owner.req("/api/admin/users")).data;
        const v = users.find((u) => u.role === "viewer");
        await owner.req(
          "/api/admin/users/" + v.id,
          { disabled: true },
          "PATCH",
        );
        assert.equal((await viewer.req("/api/state")).status, 401);
      },
    );
    await t.test(
      "password change invalidates all previous sessions",
      async () => {
        const old = owner.cookie;
        await owner.req("/api/auth/password", {
          currentPassword: "Owner passphrase with 30 chars",
          password: "Replacement passphrase with 30 chars",
        });
        const stale = client();
        stale.cookie = old;
        assert.equal((await stale.req("/api/state")).status, 401);
        assert.equal((await owner.req("/api/state")).status, 200);
      },
    );
    await t.test("logout revokes session and audit persists", async () => {
      const events = (await owner.req("/api/admin/audit")).data;
      assert.ok(events.some((e) => e.action === "password.changed"));
      assert.equal((await owner.req("/api/auth/logout", {})).status, 200);
      assert.equal((await owner.req("/api/state")).status, 401);
    });
  } finally {
    await new Promise((r) => server.close(r));
    jobs.close();
    db.close();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
});
