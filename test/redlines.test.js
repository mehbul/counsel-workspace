const { test } = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("jszip");
const express = require("express");
const {
  completeDiff,
  trackedChangeDocx,
  installRedlines,
} = require("../redlines");

test("complete comparison reconstructs both documents including beyond old excerpt limit", () => {
  for (const [before, after] of [
    ["", ""],
    ["a\nβ \t", "a\nγ \t"],
    ["a ".repeat(2000) + "OLD", "a ".repeat(2000) + "NEW"],
    ["a ".repeat(2000), "b ".repeat(2000)],
  ]) {
    const d = completeDiff(before, after);
    assert.equal(d.truncated, false);
    assert.equal(
      d.parts
        .filter((p) => p.kind !== "added")
        .map((p) => p.text)
        .join(""),
      before,
    );
    assert.equal(
      d.parts
        .filter((p) => p.kind !== "removed")
        .map((p) => p.text)
        .join(""),
      after,
    );
  }
  assert.equal(completeDiff("a ".repeat(2000), "b ".repeat(2000)).coarse, true);
});

test("DOCX export contains actual inserted and deleted revision elements", async () => {
  const bytes = await trackedChangeDocx(
    completeDiff("Old cap £100\nEnd", "New cap £900\nEnd"),
  );
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml").async("string");
  assert.match(xml, /<w:ins\b/);
  assert.match(xml, /<w:del\b/);
  assert.match(xml, /<w:delText[^>]*>Old/);
  assert.match(xml, />New<\/w:t>/);
  assert.match(xml, /w:author="Counsel Workspace"/);
  const settings = await zip.file("word/settings.xml").async("string");
  assert.match(settings, /w:trackRevisions/);
});

test("full comparison and Word routes reject inaccessible or cross-matter documents", async (t) => {
  const app = express();
  app.use(express.json());
  const c = {
    state: {
      matters: [{ id: "m" }],
      documents: [
        { id: "a", matterId: "m", text: "one" },
        { id: "b", matterId: "other", text: "two" },
      ],
    },
  };
  installRedlines(app, () => c);
  app.use((e, req, res, next) =>
    res.status(e.status || 500).json({ error: e.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const endpoint of ["compare-full", "redline.docx"]) {
    const r = await fetch(
      `http://127.0.0.1:${server.address().port}/api/documents/${endpoint}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: ["a", "b"] }),
      },
    );
    assert.equal(r.status, 404);
  }
});
