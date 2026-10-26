const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildCuadSuite } = require("../evaluation/cuad");
const {
  paragraphRanges,
  validateSuite,
  writeSuite,
  readSuite,
  jsonl,
} = require("../evaluation/suite");
const { tokenF1, evaluatePredictions } = require("../evaluation/scorer");
const { retrievalPredictions } = require("../evaluation/retrieval");
const {
  selectCases,
  buildPrompt,
  convertOutput,
  requireChatGptSignIn,
} = require("../scripts/evaluate-codex");

// These tiny examples test evaluation mechanics; they are not legal-quality benchmark data.
function contract(title, context, questions) {
  return {
    title,
    paragraphs: [
      {
        context,
        qas: questions.map(([category, excerpts], i) => ({
          id: title + "__" + category,
          question: `Highlight the parts (if any) of this contract related to "${category}" that should be reviewed by a lawyer.`,
          is_impossible: excerpts.length === 0,
          answers: excerpts.map((text) => ({
            text,
            answer_start: [...context.slice(0, context.indexOf(text))].length,
          })),
        })),
      },
    ],
  };
}
function fixture(options = {}) {
  const train = {
    data: [
      contract(
        "Training only",
        "A training contract with no matching clause.",
        [["Fees", []]],
      ),
    ],
  };
  const test = {
    data: [
      contract(
        "Test A",
        "🙂 TITLE\n\nThe fee is USD 25.\n\nPayment is monthly.\n\nThe term is one year.",
        [
          ["Fees", ["The fee is USD 25.", "Payment is monthly."]],
          ["Arbitration", []],
        ],
      ),
      contract(
        "Test B",
        "TITLE B\n\nThe arrangement is governed by English law.",
        [["Governing Law", ["The arrangement is governed by English law."]]],
      ),
    ],
  };
  return {
    train,
    test,
    suite: buildCuadSuite(
      { train, test },
      { testDocuments: 2, developmentDocuments: 1, seed: "fixed", ...options },
    ),
  };
}
function oracle(suite, split = "test") {
  const docs = new Map(suite.documents.map((d) => [d.id, d]));
  return suite.labels
    .filter((l) => l.split === split)
    .map((l) => {
      const d = docs.get(l.documentId),
        paragraphs = paragraphRanges(d.text);
      return {
        id: l.id,
        documentId: d.id,
        documentSha256: d.sha256,
        abstained: !l.answerable,
        answers: l.answers.map((a) => ({ ...a })),
        citations: l.answers.map((a) => ({
          documentId: d.id,
          quote: a.text,
          paragraph:
            paragraphs.findIndex((p) => p.start <= a.start && p.end >= a.end) +
            1,
        })),
      };
    });
}

test("CUAD import preserves official contract partitions, separates labels and converts Unicode offsets", () => {
  const { suite } = fixture();
  assert.equal(suite.manifest.dataset.pinnedInputsVerified, false);
  assert.match(suite.manifest.dataset.license, /CC-BY/);
  assert.equal(suite.manifest.partitions.length, 3);
  for (const p of suite.prompts) {
    assert.ok(!("answers" in p));
    assert.ok(!("answerable" in p));
  }
  const label = suite.labels.find((l) => l.answers.length === 2),
    d = suite.documents.find((d) => d.id === label.documentId);
  assert.equal(label.answers[0].start, d.text.indexOf("The fee"));
  assert.equal(
    d.text.slice(label.answers[0].start, label.answers[0].end),
    label.answers[0].text,
  );
  assert.deepEqual(fixture().suite, suite);
});

test("document sampling is independent of input order and contains whole-document question groups", () => {
  const { train, test: input, suite } = fixture({ testDocuments: 1 });
  const reversed = buildCuadSuite(
    { train, test: { data: [...input.data].reverse() } },
    { seed: "fixed", testDocuments: 1, developmentDocuments: 1 },
  );
  assert.deepEqual(
    reversed.documents.map((d) => d.id),
    suite.documents.map((d) => d.id),
  );
  assert.deepEqual(
    reversed.prompts.map((p) => p.id),
    suite.prompts.map((p) => p.id),
  );
  assert.equal(
    new Set(
      suite.prompts.filter((p) => p.split === "test").map((p) => p.documentId),
    ).size,
    1,
  );
});

test("cross-partition content and title overlap fail even when the leaked document was not sampled", () => {
  const { train, test: input } = fixture();
  const leaked = structuredClone(input);
  leaked.data.push({ ...train.data[0], title: "Different name same source" });
  assert.throws(
    () => buildCuadSuite({ train, test: leaked }, { testDocuments: 1 }),
    /leakage/,
  );
  const renamed = structuredClone(input);
  renamed.data[0].title = train.data[0].title;
  assert.throws(() => buildCuadSuite({ train, test: renamed }), /leakage/);
});

test("exact duplicate source contracts within a partition are excluded with provenance", () => {
  const { train, test: input } = fixture();
  train.data.push({
    ...structuredClone(train.data[0]),
    title: "Duplicate training title",
  });
  const suite = buildCuadSuite({ train, test: input });
  assert.equal(suite.manifest.excludedDuplicates.length, 1);
  assert.equal(
    suite.manifest.partitions.filter((p) => p.split === "development").length,
    1,
  );
});

test("tampered source and gold offsets, duplicated questions, and labels hidden in prompts fail closed", () => {
  const { suite } = fixture();
  const tampered = structuredClone(suite);
  tampered.documents[0].text += " changed";
  assert.throws(() => validateSuite(tampered), /hash/);
  const badAnswer = structuredClone(suite);
  badAnswer.labels.find((l) => l.answers.length).answers[0].start++;
  assert.throws(() => validateSuite(badAnswer), /exact source/);
  const badPrompt = structuredClone(suite);
  badPrompt.prompts[0].answerable = true;
  assert.throws(() => validateSuite(badPrompt), /labels must remain separate/);
  const duplicate = structuredClone(suite);
  duplicate.prompts.push(duplicate.prompts[0]);
  assert.throws(() => validateSuite(duplicate), /Duplicate prompt/);
});

test("all annotated spans and explicit abstentions produce full extraction scores on unit fixtures", () => {
  const { suite } = fixture(),
    report = evaluatePredictions(suite, oracle(suite));
  assert.equal(report.status, "complete");
  assert.equal(report.spanExactMatch, 1);
  assert.equal(report.tokenF1, 1);
  assert.equal(report.citations.exactReferencePrecision, 1);
  assert.equal(report.retrieval.goldSpanRecall, 1);
  assert.equal(report.answerability.correctAbstentionRate, 1);
  assert.ok(report.limitations.some((s) => s.includes("Legora")));
});

test("missing predictions never count as correct abstentions and remain in every denominator", () => {
  const { suite } = fixture(),
    report = evaluatePredictions(suite, []);
  assert.equal(report.status, "incomplete");
  assert.equal(report.providedPredictions, 0);
  assert.equal(report.missingPredictions, 3);
  assert.equal(report.spanExactMatch, 0);
  assert.equal(report.tokenF1, 0);
  assert.equal(report.answerability.correctAbstentionRate, 0);
  assert.equal(report.answerability.missingUnanswerable, 1);
  assert.equal(report.answerability.precision, null);
});

test("one extracted span cannot satisfy a multiple-clause annotation", () => {
  const { suite } = fixture(),
    predictions = oracle(suite),
    row = predictions.find((p) => p.answers.length === 2);
  row.answers.pop();
  row.citations.pop();
  const report = evaluatePredictions(suite, predictions),
    result = report.results.find((r) => r.id === row.id);
  assert.equal(result.exactMatch, 0);
  assert.ok(result.tokenF1 > 0 && result.tokenF1 < 1);
  assert.equal(report.retrieval.goldSpanRecall, 2 / 3);
});

test("fabricated answer text, source identity, paragraph anchors and quotations are evaluated independently", () => {
  const { suite } = fixture(),
    predictions = oracle(suite),
    answer = predictions.find((p) => p.answers.length === 1);
  answer.answers[0].text = "Invented source text";
  answer.citations[0].paragraph = 999;
  const report = evaluatePredictions(suite, predictions),
    result = report.results.find((r) => r.id === answer.id);
  assert.equal(result.exactMatch, 0);
  assert.equal(result.tokenF1, 0);
  assert.equal(result.validCitations, 0);
  assert.equal(report.citations.invalidAnswerSpans, 1);
  const changedIdentity = oracle(suite);
  changedIdentity[0].documentSha256 = "0".repeat(64);
  assert.throws(
    () => evaluatePredictions(suite, changedIdentity),
    /source hash/,
  );
  const forgedCitation = oracle(suite),
    target = forgedCitation.find((p) => p.citations.length);
  target.citations[0].quote = "This quote was never in this contract.";
  target.citations[0].documentId = "another-document";
  assert.ok(
    evaluatePredictions(suite, forgedCitation).citations
      .exactReferencePrecision < 1,
  );
});

test("duplicate or foreign predictions, development predictions in a test run, and ambiguous answer state are rejected", () => {
  const { suite } = fixture(),
    predictions = oracle(suite);
  assert.throws(
    () => evaluatePredictions(suite, [predictions[0], predictions[0]]),
    /Duplicate prediction/,
  );
  assert.throws(
    () => evaluatePredictions(suite, [{ ...predictions[0], id: "unknown" }]),
    /outside/,
  );
  assert.throws(
    () => evaluatePredictions(suite, oracle(suite, "development")),
    /outside/,
  );
  const invalid = oracle(suite);
  invalid[0].abstained = !invalid[0].abstained;
  assert.throws(
    () => evaluatePredictions(suite, invalid),
    /explicitly abstain/,
  );
  const duplicateSpan = oracle(suite),
    row = duplicateSpan.find((p) => p.answers.length);
  row.answers.push(row.answers[0]);
  assert.throws(
    () => evaluatePredictions(suite, duplicateSpan),
    /Duplicate predicted answer spans/,
  );
});

test("overlapping valid quotations cannot inflate source character coverage beyond one", () => {
  const { suite } = fixture(),
    predictions = oracle(suite),
    row = predictions.find((p) => p.citations.length);
  row.citations.push(row.citations[0], row.citations[0]);
  assert.equal(
    evaluatePredictions(suite, predictions).retrieval.goldCharacterCoverage,
    1,
  );
});

test("token scoring accounts for repetitions and distinguishes unrelated text", () => {
  assert.equal(tokenF1("The governing law.", "governing law"), 1);
  assert.equal(tokenF1("pay pay fee", "pay"), 0.5);
  assert.equal(tokenF1("England", "France"), 0);
});

test("retrieval runner receives no private annotations and emits exact source offsets", () => {
  const { suite } = fixture();
  let calls = 0;
  const predictions = retrievalPredictions(
    { documents: suite.documents, prompts: suite.prompts },
    {
      queryMode: "category",
      retrieve: (question, docs, options) => {
        calls++;
        assert.deepEqual(Object.keys(docs[0]).sort(), ["id", "name", "text"]);
        assert.ok(!("answers" in docs[0]));
        assert.equal(options.limit, 3);
        const paragraph = paragraphRanges(docs[0].text)[1];
        return [
          {
            documentId: docs[0].id,
            paragraph: 2,
            text: paragraph.text,
            startOffset: 0,
          },
        ];
      },
    },
  );
  assert.equal(calls, 3);
  const report = evaluatePredictions(suite, predictions);
  assert.equal(report.citations.invalidAnswerSpans, 0);
  assert.equal(report.citations.exactReferencePrecision, 1);
});

test("saved suites verify hashes, output directories cannot be overwritten, and incomplete CLI runs exit nonzero", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "counsel-evaluation-test-"),
  );
  try {
    const location = path.join(directory, "suite"),
      { suite } = fixture();
    writeSuite(location, suite);
    assert.equal(readSuite(location).prompts.length, 4);
    assert.throws(() => writeSuite(location, suite), /already exists/);
    const file = path.join(directory, "predictions.jsonl"),
      output = path.join(directory, "report.json");
    fs.writeFileSync(file, jsonl([]));
    const child = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, "../scripts/evaluate-legal.js"),
        "--suite",
        location,
        "--predictions",
        file,
        "--out",
        output,
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(child.status, 2, child.stderr);
    assert.equal(
      JSON.parse(fs.readFileSync(output, "utf8")).missingPredictions,
      3,
    );
    fs.appendFileSync(path.join(location, "prompts.jsonl"), "\n");
    assert.throws(() => readSuite(location), /file hash mismatch/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("live Codex case selection uses no answer labels and sends complete sources without silent clipping", () => {
  const { suite } = fixture(),
    selected = selectCases(suite, {
      maxDocuments: 1,
      maxCases: 2,
      seed: "live-test",
    });
  assert.equal(selected.documents.length, 1);
  assert.equal(selected.prompts.length, 2);
  const changedLabels = structuredClone(suite);
  changedLabels.labels.forEach((l) => {
    l.answerable = !l.answerable;
  });
  assert.deepEqual(
    selectCases(changedLabels, {
      maxDocuments: 1,
      maxCases: 2,
      seed: "live-test",
    }).prompts,
    selected.prompts,
  );
  const prompt = buildPrompt({
    documents: selected.documents,
    prompts: selected.prompts,
    labels: [{ secretAnswer: "label-leak-sentinel" }],
  });
  assert.ok(!prompt.includes("label-leak-sentinel"));
  assert.ok(
    prompt.includes(JSON.stringify(selected.documents[0].text).slice(1, -1)) ||
      paragraphRanges(selected.documents[0].text).every((p) =>
        prompt.includes(JSON.stringify(p.text)),
      ),
  );
  assert.throws(() => buildPrompt(selected, 10), /not be silently truncated/);
});

test("host quote conversion preserves fabricated and ambiguous locations as invalid predictions", () => {
  const { suite } = fixture(),
    selected = selectCases(suite, { maxDocuments: 1, maxCases: 2 });
  const p = selected.prompts[0],
    source = selected.documents[0],
    quote = paragraphRanges(source.text)[1].text;
  const converted = convertOutput(
    {
      predictions: [
        { id: p.id, abstained: false, answers: [{ paragraph: 2, quote }] },
      ],
    },
    selected,
  );
  assert.equal(
    source.text.slice(
      converted[0].answers[0].start,
      converted[0].answers[0].end,
    ),
    quote,
  );
  const forged = convertOutput(
    {
      predictions: [
        {
          id: p.id,
          abstained: false,
          answers: [{ paragraph: 2, quote: "Fabricated unseen words" }],
        },
      ],
    },
    selected,
  );
  assert.equal(forged[0].answers[0].start, -1);
  assert.throws(
    () =>
      convertOutput(
        { predictions: [{ id: "foreign-id", abstained: true, answers: [] }] },
        selected,
      ),
    /unknown case/,
  );
  const ambiguous = structuredClone(selected);
  ambiguous.documents[0].text = "TITLE\n\nRepeated phrase Repeated phrase";
  const result = convertOutput(
    {
      predictions: [
        {
          id: p.id,
          abstained: false,
          answers: [{ paragraph: 2, quote: "Repeated phrase" }],
        },
      ],
    },
    ambiguous,
  );
  assert.equal(result[0].answers[0].start, -1);
});

test("live runner refuses saved API-key auth or unknown auth before attempting paid inference", () => {
  assert.doesNotThrow(() =>
    requireChatGptSignIn(() => ({
      status: 0,
      stdout: "",
      stderr: "Logged in using ChatGPT",
    })),
  );
  assert.throws(
    () =>
      requireChatGptSignIn(() => ({
        status: 0,
        stdout: "Logged in using an API key",
        stderr: "",
      })),
    /requires existing ChatGPT/,
  );
  assert.throws(
    () =>
      requireChatGptSignIn(() => ({
        status: 1,
        stdout: "",
        stderr: "Not logged in",
      })),
    /requires existing ChatGPT/,
  );
  assert.throws(
    () =>
      requireChatGptSignIn(() => ({
        status: null,
        error: new Error("missing executable"),
      })),
    /requires existing ChatGPT/,
  );
});
