const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");
const Y = require("yjs");
process.env.COUNSEL_DB = ":memory:";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "counsel-collab-"),
);
const { app, db, jobs, createServer, collaboration } = require("../server");
test("two editors converge, persist, reconnect; viewers cannot edit; origin and ACL are enforced", async () => {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  function client() {
    return {
      cookie: "",
      csrf: "",
      async req(p, body, method = body ? "POST" : "GET") {
        const r = await fetch(base + "/api/" + p, {
          method,
          headers: {
            Cookie: this.cookie,
            "X-CSRF-Token": this.csrf,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (r.headers.get("set-cookie"))
          this.cookie = r.headers.get("set-cookie").split(";")[0];
        const data = await r.json();
        if (data.csrf) this.csrf = data.csrf;
        return data;
      },
    };
  }
  async function connect(client, draftId, origin = base) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        base.replace("http:", "ws:") + "/collaboration?draft=" + draftId,
        { headers: { Cookie: client.cookie, Origin: origin } },
      );
      clients.push(ws);
      const doc = new Y.Doc();
      ws.on("error", reject);
      ws.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.update)
          Y.applyUpdate(
            doc,
            new Uint8Array(Buffer.from(m.update, "base64")),
            "remote",
          );
        if (m.type === "sync") resolve({ ws, doc, readOnly: m.readOnly });
      });
      doc.on("update", (u, o) => {
        if (o === "local")
          ws.send(
            JSON.stringify({
              type: "update",
              update: Buffer.from(u).toString("base64"),
            }),
          );
      });
    });
  }
  const wait = async (fn) => {
    const end = Date.now() + 3000;
    while (!fn()) {
      if (Date.now() > end) throw Error("Timed out waiting for convergence");
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  try {
    const owner = client();
    await owner.req("auth/setup", {
      token: fs.readFileSync(
        path.join(process.env.DATA_DIR, "bootstrap-token"),
        "utf8",
      ),
      email: "owner@collab.test",
      password: "Owner test phrase with length",
      workspace: "Collaboration test",
    });
    const state = await owner.req("state"),
      matterId = state.matters[0].id;
    const draft = await owner.req("drafts", {
      matterId,
      title: "Shared memo",
      prompt: "governing law",
    });
    const first = await connect(owner, draft.id),
      second = await connect(owner, draft.id);
    const original = first.doc.getText("content").length;
    first.doc.transact(
      () => first.doc.getText("content").insert(0, "First editor. "),
      "local",
    );
    second.doc.transact(
      () => second.doc.getText("content").insert(original, " Second editor."),
      "local",
    );
    await wait(
      () =>
        first.doc.getText("content").toString() ===
          second.doc.getText("content").toString() &&
        first.doc.getText("content").toString().includes("Second editor."),
    );
    const saved = (await owner.req("state")).drafts.find(
      (d) => d.id === draft.id,
    );
    assert.ok(saved.content.startsWith("First editor."));
    assert.ok(saved.content.endsWith(" Second editor."));
    assert.ok(
      db
        .prepare("SELECT content FROM collaborative_drafts WHERE draft_id=?")
        .get(draft.id),
    );
    await assert.rejects(connect(owner, draft.id, "https://untrusted.example"));
    await owner.req("admin/users", {
      email: "viewer@collab.test",
      password: "Viewer test phrase with length",
      role: "viewer",
    });
    const users = await owner.req("admin/users"),
      viewerId = users.find((u) => u.role === "viewer").id;
    await owner.req("admin/access", {
      userId: viewerId,
      matterId,
      allowed: true,
    });
    const viewer = client();
    await viewer.req("auth/login", {
      email: "viewer@collab.test",
      password: "Viewer test phrase with length",
    });
    const read = await connect(viewer, draft.id);
    assert.equal(read.readOnly, true);
    const closed = new Promise((r) => read.ws.once("close", (code) => r(code)));
    read.doc.transact(
      () => read.doc.getText("content").insert(0, "FORBIDDEN"),
      "local",
    );
    assert.equal(await closed, 1008);
    assert.ok(
      !(await owner.req("state")).drafts
        .find((d) => d.id === draft.id)
        .content.includes("FORBIDDEN"),
    );
    await owner.req("admin/access", {
      userId: viewerId,
      matterId,
      allowed: false,
    });
    await assert.rejects(connect(viewer, draft.id));
    first.ws.close();
    second.ws.close();
    await new Promise((r) => setTimeout(r, 60));
    const reconnected = await connect(owner, draft.id);
    assert.equal(reconnected.doc.getText("content").toString(), saved.content);
  } finally {
    for (const ws of clients) ws.terminate();
    collaboration.close();
    await jobs.close();
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
});
