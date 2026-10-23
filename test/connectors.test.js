const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const { randomUUID } = require("node:crypto");
const { context } = require("../security");
const { createConnectors } = require("../connectors");
test("connector credentials encrypted; repeated imports idempotent; changes retain old citations; explicit DOCX writeback", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "counsel-connectors-"));
  process.env.DATA_DIR = folder;
  const db = new DatabaseSync(":memory:"),
    wid = randomUUID(),
    uid = randomUUID(),
    mid = randomUUID(),
    state = {
      matters: [{ id: mid }],
      documents: [],
      drafts: [
        {
          id: randomUUID(),
          matterId: mid,
          title: "Approved memo",
          content: "Approved output",
        },
      ],
    };
  let version = "1",
    writes = 0,
    fetches = [];
  const mockFetch = async (url, init = {}) => {
    fetches.push(String(url));
    if (String(url).startsWith("https://login.microsoftonline.com/"))
      return Response.json({ access_token: "graph-token" });
    if (
      String(url).startsWith("https://graph.microsoft.com/") &&
      init.method === "PUT"
    ) {
      writes++;
      return Response.json({ id: "new-graph-file" });
    }
    if (
      String(url).startsWith("https://graph.microsoft.com/") &&
      String(url).includes("/children?")
    )
      return Response.json({
        value: [
          {
            id: "graph-item",
            name: "graph.txt",
            eTag: version,
            size: 100,
            file: {},
          },
        ],
      });
    if (String(url).startsWith("https://graph.microsoft.com/"))
      return new Response(null, {
        status: 302,
        headers: { Location: "https://tenant.sharepoint.com/download/signed" },
      });
    if (String(url).startsWith("https://tenant.sharepoint.com/")) {
      assert.ok(!init.headers?.Authorization);
      return new Response("Graph agreement. Governing law is New York.");
    }

    if (url === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "provider-token" });
    if (String(url).includes("/upload/drive/")) {
      writes++;
      assert.match(String(init.headers["Content-Type"]), /multipart/);
      return Response.json({ id: "new-file" });
    }
    if (String(url).includes("alt=media"))
      return new Response(
        "Agreement\n\nGoverning law is England. Version " + version,
      );
    if (String(url).includes("/drive/v3/files?"))
      return Response.json({
        files: [
          {
            id: "remote-1",
            name: "agreement.txt",
            modifiedTime: version,
            size: 100,
          },
        ],
      });
    throw Error("Unexpected endpoint");
  };
  const app = express();
  app.use(express.json());
  let role = "owner";
  const store = { workspaceId: wid, actor: uid, role: "owner", state };
  app.use((req, res, next) => {
    req.user = { id: uid, role, workspace_id: wid };
    context.run({ ...store, role }, next);
  });
  const audit = [];
  const connectors = createConnectors(
    app,
    db,
    { audit: (...x) => audit.push(x) },
    () => {},
    () => {},
    { fetch: mockFetch },
  );
  app.use((err, req, res, next) =>
    res.status(400).json({ error: "Connector request failed" }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/connectors`;
  const req = async (p, body, method = body ? "POST" : "GET") => {
    const r = await fetch(base + p, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    const created = await req("", {
      provider: "google",
      name: "Firm drive",
      clientId: "test-client",
      clientSecret: "secret-never-expose",
      refreshToken: "private-refresh",
      folderId: "folder-1",
      matterId: mid,
    });
    assert.equal(created.status, 200);
    const id = created.data.id;
    const encoded = db.prepare("SELECT config FROM connectors").get().config;
    assert.ok(!encoded.includes("secret-never-expose"));
    assert.ok(!encoded.includes("private-refresh"));
    assert.ok(
      !JSON.stringify((await req("")).data).includes("private-refresh"),
    );
    const sync = () =>
      context.run(store, () =>
        connectors.sync({ connectorId: id, matterId: mid }),
      );
    assert.equal((await sync()).imported, 1);
    const original = state.documents[0];
    assert.equal((await sync()).skipped, 1);
    assert.equal(state.documents.length, 1);
    version = "2";
    assert.equal((await sync()).updated, 1);
    assert.equal(state.documents.length, 2);
    assert.equal(original.supersededBy, state.documents[1].id);
    assert.ok(original.text.includes("Version 1"));
    const exported = await req("/" + id + "/export", {
      draftId: state.drafts[0].id,
      filename: "approved.docx",
    });
    assert.equal(exported.status, 200);
    assert.equal(writes, 1);
    role = "viewer";
    assert.equal((await req("")).status, 403);
    assert.equal(
      (
        await req("/" + id + "/export", {
          draftId: state.drafts[0].id,
          filename: "forbidden.docx",
        })
      ).status,
      403,
    );
    assert.equal(writes, 1);
    assert.ok(
      fetches.every(
        (u) =>
          u.startsWith("https://oauth2.googleapis.com/") ||
          u.startsWith("https://www.googleapis.com/"),
      ),
    );
    role = "owner";
    await req("/" + id, undefined, "DELETE");
    assert.equal(db.prepare("SELECT * FROM connectors").all().length, 0);
    assert.equal(state.documents.length, 2);
    const ms = await req("", {
      provider: "microsoft",
      name: "SharePoint",
      clientId: randomUUID(),
      tenantId: randomUUID(),
      clientSecret: "graph-private",
      driveId: "drive-1",
      folderId: "root",
      matterId: mid,
    });
    assert.equal(ms.status, 200);
    const result = await context.run(store, () =>
      connectors.sync({ connectorId: ms.data.id, matterId: mid }),
    );
    assert.equal(result.imported, 1);
    assert.ok(state.documents.some((d) => d.text.includes("New York")));
    assert.equal(
      (
        await req("/" + ms.data.id + "/export", {
          draftId: state.drafts[0].id,
          filename: "graph-export.docx",
        })
      ).status,
      200,
    );
    assert.equal(writes, 2);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
