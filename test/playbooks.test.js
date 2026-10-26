const { test } = require("node:test");
const assert = require("node:assert/strict");
const { evaluatePlaybook } = require("../playbooks");
const book = {
  name: "Assignment policy",
  jurisdiction: "Internal commercial policy",
  rules: [
    {
      name: "Consent",
      query: "assignment",
      preferred: "Prior written consent",
      severity: "high",
    },
  ],
};
const docs = [
  {
    id: "d",
    name: "Contract",
    text: "Assignment requires prior written consent.",
  },
];
test("evidence playbooks make no inference or risk determination", async () => {
  const r = await evaluatePlaybook(book, docs);
  assert.equal(r.cells[0].status, "evidence_found");
  assert.equal(r.cells[0].severity, null);
  assert.equal(r.cells[0].reviewed, false);
});
test("generated playbook review verifies exact quotes and keeps review unapproved", async () => {
  const r = await evaluatePlaybook(book, docs, {
    generate: async () => ({
      text: JSON.stringify({
        findings: [
          {
            rule: 0,
            status: "matches",
            reason: "Consent is required.",
            quotes: [{ paragraph: 1, quote: "prior written consent" }],
          },
        ],
      }),
    }),
  });
  assert.equal(r.cells[0].status, "matches");
  assert.equal(r.cells[0].reviewed, false);
  assert.equal(r.coverage[0].completeSourceSuppliedToModel, true);
});
test("fabricated evidence and incomplete findings fail before saving", async () => {
  await assert.rejects(
    evaluatePlaybook(book, docs, {
      generate: async () => ({
        text: JSON.stringify({
          findings: [
            {
              rule: 0,
              status: "matches",
              reason: "Consent",
              quotes: [{ paragraph: 1, quote: "fabricated" }],
            },
          ],
        }),
      }),
    }),
    /does not match/,
  );
  await assert.rejects(
    evaluatePlaybook(book, docs, {
      generate: async () => ({ text: '{"findings":[]}' }),
    }),
    /incomplete/,
  );
});
test("oversized complete sources are refused before any inference", async () => {
  let calls = 0;
  await assert.rejects(
    evaluatePlaybook(book, [...docs, { id: "big", text: "x".repeat(80001) }], {
      generate: async () => {
        calls++;
      },
    }),
    /80,000/,
  );
  assert.equal(calls, 0);
});
