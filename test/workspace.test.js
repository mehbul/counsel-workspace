process.env.DATA_DIR = require("node:fs").mkdtempSync(
  require("node:path").join(require("node:os").tmpdir(), "counsel-test-"),
);
process.env.COUNSEL_DB = ":memory:";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { app, retrieve } = require("../server");
test("retrieval returns only supplied document evidence", () => {
  const r = retrieve("governing law", [
    { id: "one", name: "A", text: "Title\n\nGoverning law is New York." },
  ]);
  assert.equal(r[0].documentId, "one");
  assert.equal(r[0].paragraph, 2);
  assert.deepEqual(
    retrieve("unmentioned", [{ id: "one", text: "No relevant clause" }]),
    [],
  );
});
test("matter import, cited search, review locking and Word export", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  let cookie = "",
    csrf = "";
  const req = async (p, body, method = "POST") => {
    const r = await fetch(base + p, {
      method,
      headers: {
        ...(body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        Cookie: cookie,
        "X-CSRF-Token": csrf,
      },
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
    if (r.headers.get("set-cookie"))
      cookie = r.headers.get("set-cookie").split(";")[0];
    const data = await r.json();
    if (data.csrf) csrf = data.csrf;
    return { status: r.status, data };
  };
  try {
    const token = require("node:fs").readFileSync(
      require("node:path").join(process.env.DATA_DIR, "bootstrap-token"),
      "utf8",
    );
    await req("auth/setup", {
      token,
      email: "owner@example.test",
      password: "a secure test passphrase 123",
      workspace: "Test firm",
    });
    const { data: m } = await req("matters", {
      name: "Integration test",
      client: "Synthetic",
    });
    const form = new FormData();
    form.append("matterId", m.id);
    form.append(
      "files",
      new Blob([
        "AGREEMENT\n\nGoverning law is England.\n\nLiability is capped at GBP 100.",
      ]),
      "test.txt",
    );
    const imported = await req("documents", form);
    assert.equal(imported.data.length, 1);
    const did = imported.data[0].id;
    const chat = await req("chat", { matterId: m.id, query: "governing law" });
    assert.equal(chat.status, 200);
    assert.ok(chat.data.citations.every((c) => c.documentId === did));
    const { data: r } = await req("reviews", {
      matterId: m.id,
      columns: ["Governing law", "Liability cap"],
    });
    assert.equal(r.cells.length, 2);
    const c = r.cells[0];
    await req(`reviews/${r.id}/cells/${c.id}`, { locked: true }, "PATCH");
    assert.equal(
      (
        await req(
          `reviews/${r.id}/cells/${c.id}`,
          { value: "changed" },
          "PATCH",
        )
      ).status,
      409,
    );
    await req(`reviews/${r.id}/cells/${c.id}`, { locked: false }, "PATCH");
    assert.equal(
      (
        await req(
          `reviews/${r.id}/cells/${c.id}`,
          { value: "Reviewed finding", reviewed: true },
          "PATCH",
        )
      ).status,
      200,
    );
    const { data: d } = await req("drafts", {
      matterId: m.id,
      title: "Test memo",
      prompt: "governing law",
    });
    const exported = await fetch(base + `drafts/${d.id}/export`, {
      headers: { Cookie: cookie },
    });
    assert.equal(exported.status, 200);
    const bytes = new Uint8Array(await exported.arrayBuffer());
    assert.equal(bytes[0], 80);
    assert.equal(bytes[1], 75);
    await req("documents/" + did, undefined, "DELETE");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
