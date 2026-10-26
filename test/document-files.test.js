const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { createDocumentFiles } = require("../document-files");
const express = require("express");

test("original bytes are immutable and require current workspace, matter and document access", () => {
  const db = new DatabaseSync(":memory:");
  let c = {
    workspaceId: "w1",
    state: {
      matters: [{ id: "m1" }],
      documents: [{ id: "d1", matterId: "m1", name: "source.docx" }],
    },
  };
  const files = createDocumentFiles(db, () => c),
    original = Buffer.from([0, 255, 3, 7]);
  const metadata = files.retain("d1", original);
  assert.equal(metadata.size, 4);
  assert.deepEqual(files.read("d1").bytes, original);
  assert.throws(() => files.retain("d1", Buffer.from("overwrite")));
  c.workspaceId = "w2";
  assert.throws(() => files.read("d1"), { status: 404 });
  c.workspaceId = "w1";
  c.state.matters = [];
  assert.throws(() => files.read("d1"), { status: 404 });
  c.state.matters = [{ id: "m1" }];
  c.state.documents = [];
  assert.throws(() => files.read("d1"), { status: 404 });
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM document_originals").get().n,
    1,
  );
  db.close();
});

test("original HTTP download preserves bytes and rejects removed documents", async (t) => {
  const db = new DatabaseSync(":memory:");
  const c = {
    workspaceId: "w",
    state: {
      matters: [{ id: "m" }],
      documents: [{ id: "d", matterId: "m", name: "original.pdf" }],
    },
  };
  const files = createDocumentFiles(db, () => c),
    bytes = Buffer.from([37, 80, 68, 70, 0, 255]);
  files.retain("d", bytes, "application/pdf");
  const app = express();
  files.install(app);
  app.use((e, req, res, next) =>
    res.status(e.status || 500).json({ error: e.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/api/documents/d/original`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.match(
    response.headers.get("content-disposition"),
    /attachment; filename="?original\.pdf"?/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    response.headers.get("content-type"),
    "application/octet-stream",
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  c.state.documents = [];
  assert.equal((await fetch(url)).status, 404);
});
