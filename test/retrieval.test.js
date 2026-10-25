const { test } = require("node:test");
const assert = require("node:assert/strict");
const { retrieve } = require("../retrieval");
test("token boundaries reject substring-only evidence and empty questions", () => {
  const docs = [
    {
      id: "billing",
      name: "Administration",
      text: "The lawyer reviewed the timesheet. Capability planning is complete.",
    },
  ];
  assert.deepEqual(retrieve("law", docs), []);
  assert.deepEqual(retrieve("liability cap", docs), []);
  assert.deepEqual(retrieve("What are the documents?", docs), []);
});
test("legal concepts expand in either direction without depending on document headings", () => {
  const docs = [
    {
      id: "one",
      name: "Supply terms",
      text: "The supplier may transfer this contract only with prior written permission.\n\nEither party may cancel the arrangement after thirty days.\n\nA monthly fee of GBP 250 is due within ten days.",
    },
  ];
  assert.equal(retrieve("assignment restrictions", docs)[0].paragraph, 1);
  assert.equal(retrieve("termination", docs)[0].paragraph, 2);
  assert.equal(retrieve("payment", docs)[0].paragraph, 3);
});
test("ranks a specific clause ahead of generic mentions and diversifies results", () => {
  const docs = [
    {
      id: "notes",
      name: "Glossary",
      text: "A note about law.\n\nSome more law notes.\n\nAnother generic law note.\n\nAn unrelated lawyer.",
    },
    {
      id: "contract",
      name: "Agreement",
      text: "3. Governing law. This agreement is governed by the laws of England and Wales.",
    },
  ];
  const r = retrieve("governing law", docs);
  assert.equal(r[0].documentId, "contract");
  assert.ok(r.filter((x) => x.documentId === "notes").length <= 3);
  assert.ok(r.some((x) => x.documentId === "contract"));
});
test("clips long paragraphs around evidence while retaining exact offsets and paragraph anchors", () => {
  const prefix = "Background material unrelated to the question. ".repeat(300),
    clause = "Governing law is New York.",
    suffix = " Administrative background.".repeat(300),
    source = prefix + clause + suffix;
  const docs = [
    { id: "one", name: "Long agreement", text: "Title\n\n" + source },
  ];
  const r = retrieve("governing law", docs, { maxChars: 600 });
  assert.equal(r[0].paragraph, 2);
  assert.ok(r[0].text.includes(clause));
  assert.ok(r.every((x) => x.text.length <= 600));
  assert.equal(source.slice(r[0].startOffset, r[0].endOffset), r[0].text);
});
test("superseded versions are omitted unless explicitly selected; limits remain bounded", () => {
  const docs = [
    {
      id: "old",
      name: "Old",
      text: "Governing law is England.",
      supersededBy: "new",
    },
    { id: "new", name: "New", text: "Governing law is France." },
  ];
  assert.equal(retrieve("governing law", docs).length, 1);
  assert.equal(
    retrieve("governing law", [docs[0]], { includeSuperseded: true })[0]
      .documentId,
    "old",
  );
  assert.equal(retrieve("governing law", docs, { limit: 1 }).length, 1);
});
test("synthetic ranking benchmark improves on the prior substring baseline", () => {
  const { evaluate } = require("../scripts/benchmark-retrieval");
  const report = evaluate();
  assert.ok(
    report.current.hitAt3 >= report.baseline.hitAt3 + 0.15,
    JSON.stringify(report),
  );
  assert.ok(report.current.mrrAt3 > report.baseline.mrrAt3);
  assert.ok(
    report.current.falsePositiveRate <= report.baseline.falsePositiveRate,
  );
});

test("generic overviews select diverse evidence while specific missing-summary topics abstain", () => {
  const docs = [
    {
      id: "one",
      name: "First",
      text: "TITLE\n\nThe recipient shall protect confidential material for three years after termination.",
    },
    {
      id: "two",
      name: "Second",
      text: "TITLE\n\nMonthly service fees are payable within thirty days after receipt of an invoice.",
    },
  ];
  const summary = retrieve("Give me an overview of this matter", docs);
  assert.equal(new Set(summary.map((x) => x.documentId)).size, 2);
  assert.ok(summary.every((x) => x.paragraph === 2));
  assert.deepEqual(retrieve("Summarize arbitration provisions", docs), []);
  assert.deepEqual(retrieve("Summarize pink elephants", docs), []);
});

test("overview intent needs an explicit summary request and accepts normal drafting verbs", () => {
  const docs = [
    {
      id: "one",
      text: "1. Term. This agreement continues for two years after signature.\n\n2. Fees. Supplier bills each month for work performed under this contract.",
    },
  ];
  assert.equal(retrieve("term", docs).length, 1);
  assert.equal(retrieve("term", docs)[0].paragraph, 1);
  assert.equal(
    retrieve("Write an executive summary of this matter", docs).length,
    2,
  );
});
