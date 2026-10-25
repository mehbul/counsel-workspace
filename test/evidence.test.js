const { test } = require("node:test");
const assert = require("node:assert/strict");
const { checkEvidence } = require("../evidence");

const document = {
  id: "source-v1",
  name: "Synthetic agreement",
  text: "AGREEMENT\n\n3. Liability. Liability is capped at GBP 500,000.\n\n4. Assignment requires written consent.",
};
const citation = {
  documentId: document.id,
  name: document.name,
  paragraph: 2,
  text: "Liability is capped at GBP 500,000.",
};

test("reference integrity checks exact paragraph substrings without claiming legal accuracy", () => {
  const report = checkEvidence(
    "Liability is capped at GBP 500,000 [1].",
    [citation],
    [document],
  );
  assert.equal(report.status, "references_valid");
  assert.equal(report.validCitationCount, 1);
  assert.equal(report.citedParagraphCount, 1);
  assert.equal(report.checkedOutputText, true);
  assert.match(report.limitation, /does not establish/i);
  assert.ok(!("confidence" in report));
});

test("removed versions, changed quotations and wrong paragraph anchors fail independently", () => {
  const removed = checkEvidence("The cap is GBP 500,000 [1].", [citation], []);
  assert.equal(removed.status, "needs_review");
  assert.ok(removed.issues.some((i) => i.code === "source_missing"));
  const changed = checkEvidence(
    "The cap is GBP 500,000 [1].",
    [citation],
    [{ ...document, text: document.text.replace("500,000", "100,000") }],
  );
  assert.ok(changed.issues.some((i) => i.code === "quote_mismatch"));
  const wrong = checkEvidence(
    "The cap is GBP 500,000 [1].",
    [{ ...citation, paragraph: 3 }],
    [document],
  );
  assert.ok(wrong.issues.some((i) => i.code === "quote_mismatch"));
  const outside = checkEvidence(
    "The cap is GBP 500,000 [1].",
    [{ ...citation, paragraph: 99 }],
    [document],
  );
  assert.ok(outside.issues.some((i) => i.code === "paragraph_missing"));
});

test("unknown and zero inline references are reported instead of being silently accepted", () => {
  const report = checkEvidence(
    "The cap is GBP 500,000 [2].\n\nThe clause applies to everyone [0].",
    [citation],
    [document],
  );
  assert.equal(report.status, "needs_review");
  assert.deepEqual(
    report.issues
      .filter((i) => i.code === "reference_out_of_range")
      .map((i) => i.reference)
      .sort(),
    [0, 2],
  );
});

test("a bibliography cannot make an uncited substantive paragraph appear cited", () => {
  const report = checkEvidence(
    "Liability is capped [1].\n\nAssignment is freely permitted without consent.\n\n## Sources\n\n[1] Synthetic agreement",
    [citation],
    [document],
  );
  assert.equal(report.status, "needs_review");
  assert.equal(report.uncitedParagraphCount, 1);
  assert.match(report.uncitedParagraphs[0].text, /Assignment/);
  assert.equal(report.citedParagraphCount, 1);
});

test("bibliography-only or empty output is not labeled reference-valid", () => {
  for (const text of ["", "## Sources\n\n[1] Synthetic agreement"]) {
    const report = checkEvidence(text, [citation], [document]);
    assert.equal(report.status, "needs_review");
    assert.ok(
      report.issues.some((i) =>
        ["empty_output", "no_substantive_content"].includes(i.code),
      ),
    );
  }
});

test("decimal values, markdown links, nested brackets and code are not numeric citations", () => {
  const report = checkEvidence(
    "The clause value [1.5] is a decimal.\n\nThe linked label is external [1](https://example.test).\n\nThe nested marker is [[1]].\n\nThe example uses `[1]` as code.\n\n```txt\nOnly code [1]\n```",
    [citation],
    [document],
  );
  assert.equal(report.inlineReferenceCount, 0);
  assert.equal(report.status, "needs_review");
  assert.ok(report.uncitedParagraphCount >= 3);
});

test("local excerpt mode attributes exact source text and ignores its embedded numeric markers", () => {
  const d = {
    id: "contract",
    name: "Order",
    text: "Payment terms [99] remain confidential.",
  };
  const ref = { documentId: d.id, name: d.name, paragraph: 1, text: d.text };
  const report = checkEvidence(
    "Relevant passages from this matter:\n\n[1] Order\nPayment terms [99] remain confidential.\n\nLocal evidence search. These are source excerpts, not an AI-generated legal opinion.",
    [ref],
    [d],
    { mode: "excerpts" },
  );
  assert.equal(report.status, "references_valid");
  assert.equal(report.usedCitationCount, 1);
  assert.ok(!report.issues.some((i) => i.code === "reference_out_of_range"));
  const forged = checkEvidence(
    "[1] Order\nPayment terms are waived forever.",
    [ref],
    [d],
    { mode: "excerpts" },
  );
  assert.equal(forged.status, "needs_review");
  assert.ok(forged.issues.some((i) => i.code === "excerpt_mismatch"));
});

test("superseded sources remain verifiable but are flagged unless historical use is explicit", () => {
  const old = { ...document, supersededBy: "source-v2" };
  const report = checkEvidence("Liability is capped [1].", [citation], [old]);
  assert.equal(report.validCitationCount, 1);
  assert.equal(report.status, "needs_review");
  assert.ok(report.issues.some((i) => i.code === "source_superseded"));
  assert.equal(
    checkEvidence("Liability is capped [1].", [citation], [old], {
      allowSuperseded: true,
    }).status,
    "references_valid",
  );
});

test("fullwidth and bracket-style numeric citations work; a range is not silently expanded", () => {
  assert.equal(
    checkEvidence("Liability is capped ［１］.", [citation], [document]).status,
    "references_valid",
  );
  assert.equal(
    checkEvidence("Liability is capped 【1】.", [citation], [document]).status,
    "references_valid",
  );
  const range = checkEvidence(
    "Liability is capped [1-3].",
    [citation],
    [document],
  );
  assert.equal(range.status, "needs_review");
  assert.ok(range.issues.some((i) => i.code === "unsupported_reference_style"));
});

test("no-source notices are explicit and malformed citation data does not throw", () => {
  const missing = checkEvidence(
    "No matching evidence found in the selected documents.",
    [],
    [document],
  );
  assert.equal(missing.status, "no_sources");
  assert.equal(missing.uncitedParagraphCount, 0);
  const malformed = checkEvidence(
    "The clause applies to all parties [1].",
    [null, { documentId: document.id, paragraph: -1, text: "" }],
    [document],
  );
  assert.equal(malformed.status, "needs_review");
  assert.equal(malformed.invalidCitationCount, 2);
});

test("a matching quote does not establish that the generated interpretation follows from it", () => {
  const report = checkEvidence(
    "Liability is unlimited [1].",
    [citation],
    [document],
  );
  assert.equal(report.status, "references_valid");
  assert.match(report.limitation, /supports a claim/i);
  assert.ok(report.issues.every((i) => i.severity !== "error"));
});

test("substantive prose cannot be hidden behind a source-list heading", () => {
  const report = checkEvidence(
    "Liability is capped [1].\n\n## Sources\n\n[1] Synthetic agreement\n\nEvery assignment is permitted without consent.",
    [citation],
    [document],
  );
  assert.equal(report.status, "needs_review");
  assert.ok(report.issues.some((i) => i.code === "bibliography_prose"));
});

test("grouped references are checked individually and literal excerpt code is preserved", () => {
  const grouped = checkEvidence(
    "The cap applies to this agreement [1, 2].",
    [citation, citation],
    [document],
  );
  assert.equal(grouped.status, "references_valid");
  assert.equal(grouped.usedCitationCount, 2);
  const d = {
    id: "code-exhibit",
    name: "Code exhibit",
    text: "```txt\n[99]\n```",
  };
  const ref = { documentId: d.id, name: d.name, paragraph: 1, text: d.text };
  const report = checkEvidence("[1] Code exhibit\n" + d.text, [ref], [d], {
    mode: "excerpts",
  });
  assert.equal(report.status, "references_valid");
  assert.equal(report.checkedOutputText, true);
});

test("linked sources validate structured quotations without pretending to check cell prose", () => {
  const report = checkEvidence(
    "Uncapped liability is permitted. This interpretation has no inline marker [99].",
    [citation],
    [document],
    { mode: "linked_sources" },
  );
  assert.equal(report.mode, "linked_sources");
  assert.equal(report.status, "references_valid");
  assert.equal(report.checkedOutputText, false);
  assert.equal(report.validCitationCount, 1);
  assert.equal(report.uncitedParagraphCount, null);
  assert.equal(report.citedParagraphCount, null);
  assert.equal(report.inlineReferenceCount, null);
  assert.equal(report.usedCitationCount, null);
  assert.equal(report.unusedCitationCount, null);
  assert.deepEqual(report.invalidReferences, []);
  assert.deepEqual(report.uncitedParagraphs, []);
  assert.deepEqual(report.issues, []);
  assert.match(report.limitation, /cell interpretation.*not validated/i);
});

test("linked sources still reject unavailable sources, changed quotes and invalid paragraph anchors", () => {
  for (const [refs, docs, expected] of [
    [[citation], [], "source_missing"],
    [
      [{ ...citation, text: "Unlimited liability" }],
      [document],
      "quote_mismatch",
    ],
    [[{ ...citation, paragraph: 99 }], [document], "paragraph_missing"],
  ]) {
    const report = checkEvidence("", refs, docs, { mode: "linked_sources" });
    assert.equal(report.status, "needs_review");
    assert.equal(report.checkedOutputText, false);
    assert.equal(report.invalidCitationCount, 1);
    assert.deepEqual(
      report.issues.map((issue) => issue.code),
      [expected],
    );
  }
});

test("linked sources flag previous versions and missing citations without evaluating output text", () => {
  const previous = checkEvidence(
    null,
    [citation],
    [{ ...document, supersededBy: "v2" }],
    {
      mode: "linked_sources",
    },
  );
  assert.equal(previous.status, "needs_review");
  assert.deepEqual(
    previous.issues.map((issue) => issue.code),
    ["source_superseded"],
  );
  const missing = checkEvidence(null, [], [document], {
    mode: "linked_sources",
  });
  assert.equal(missing.status, "no_sources");
  assert.deepEqual(
    missing.issues.map((issue) => issue.code),
    ["no_sources"],
  );
  assert.equal(missing.checkedOutputText, false);
});

test("a notice prefix cannot hide an appended substantive claim from paragraph coverage", () => {
  for (const prefix of [
    "No matching evidence found.",
    "No matching evidence found in the selected documents.",
    "Local evidence search.",
    "Insufficient evidence.",
    "Not found in the supplied sources.",
  ]) {
    const report = checkEvidence(
      prefix +
        " The buyer shall pay an unlimited penalty and cannot terminate this agreement.",
      [citation],
      [document],
    );
    assert.equal(report.status, "needs_review", prefix);
    assert.equal(report.uncitedParagraphCount, 1, prefix);
    assert.ok(
      report.issues.some((issue) => issue.code === "uncited_paragraph"),
    );
  }
});

test("complete deterministic no-source notices remain recognized without suppressing other paragraphs", () => {
  const canonical =
    "No matching evidence found in the selected documents. Try a specific clause or upload relevant documents.";
  const empty = checkEvidence(canonical, [], [document], { mode: "excerpts" });
  assert.equal(empty.status, "no_sources");
  assert.equal(empty.uncitedParagraphCount, 0);
  assert.deepEqual(
    empty.issues.map((issue) => issue.code),
    ["no_sources"],
  );
  const appended = checkEvidence(
    canonical + "\n\nThe buyer shall pay an unlimited penalty.",
    [citation],
    [document],
  );
  assert.equal(appended.status, "needs_review");
  assert.equal(appended.uncitedParagraphCount, 1);
});
