const { test } = require("node:test");
const assert = require("node:assert/strict");
const { diffText, compareDocuments, comparisonCsv } = require("../comparisons");
test("word comparison reconstructs both exact excerpts including Unicode and whitespace", () => {
  for (const [before, after] of [
    ["The cap is £500.\n", "The cap is £900.\n"],
    ["", "added"],
    ["delete", ""],
    ["same text", "same text"],
    ["A\tB α", "A B β"],
  ]) {
    const d = diffText(before, after);
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
    assert.equal(d.equal, before === after);
  }
});
test("large comparisons report truncation rather than pretending full coverage", () => {
  const d = diffText("a ".repeat(2000), "b ".repeat(2000), 30);
  assert.equal(d.truncated, true);
  assert.ok(d.beforeExcerpt.length < 4000);
});
test("clause comparison surfaces differing evidence and missing matches without inferring absence", () => {
  const docs = [
    { id: "one", name: "A", text: "Governing law is England." },
    { id: "two", name: "B", text: "Governing law is New York." },
  ];
  const retrieve = (q, ds) =>
    q === "unknown"
      ? []
      : ds.map((d) => ({
          documentId: d.id,
          name: d.name,
          paragraph: 1,
          text: d.text,
          score: 1,
        }));
  const report = compareDocuments(docs, ["Governing law", "unknown"], retrieve);
  assert.equal(report.rows[0].coverage.matched, 2);
  assert.equal(report.rows[0].diff.equal, false);
  assert.equal(report.rows[1].coverage.matched, 0);
  assert.match(report.notice, /does not establish/);
});
test("comparison CSV neutralizes formulas even after whitespace and quotes every field", () => {
  const report = {
    documents: [{ name: "=document" }],
    rows: [
      {
        question: '  =HYPERLINK("bad")',
        findings: [{ sources: [{ paragraph: 1, text: "Quoted, evidence" }] }],
      },
    ],
  };
  const csv = comparisonCsv(report);
  assert.match(csv, /"'=document"/);
  assert.ok(csv.includes('"\'  =HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"Paragraph 1: Quoted, evidence"'));
});
