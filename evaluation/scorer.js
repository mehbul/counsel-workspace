const { validateSuite, paragraphRanges, uniqueBy, sha256 } = require("./suite");

function tokens(text) {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\p{P}\p{S}]/gu, " ")
      .replace(/\b(?:a|an|the)\b/gu, " ")
      .match(/[\p{L}\p{N}]+/gu) || []
  );
}
function tokenF1(expected, actual) {
  const gold = tokens(expected),
    prediction = tokens(actual);
  if (!gold.length || !prediction.length)
    return Number(gold.length === prediction.length);
  const bag = new Map();
  for (const t of gold) bag.set(t, (bag.get(t) || 0) + 1);
  let same = 0;
  for (const t of prediction) {
    if (bag.get(t)) {
      same++;
      bag.set(t, bag.get(t) - 1);
    }
  }
  return same ? (2 * same) / (gold.length + prediction.length) : 0;
}
const ratio = (a, b) => (b ? a / b : null);
function validatePrediction(p, prompt, document) {
  if (
    p.documentId !== prompt.documentId ||
    p.documentSha256 !== prompt.documentSha256 ||
    document.sha256 !== p.documentSha256
  )
    throw Error("Prediction source hash or document mismatch.");
  if (
    typeof p.abstained !== "boolean" ||
    !Array.isArray(p.answers) ||
    p.answers.length > 100 ||
    !Array.isArray(p.citations) ||
    p.citations.length > 100 ||
    p.abstained !== (p.answers.length === 0)
  )
    throw Error("Prediction must explicitly abstain or provide answer spans.");
  for (const a of p.answers)
    if (
      !Number.isInteger(a.start) ||
      !Number.isInteger(a.end) ||
      typeof a.text !== "string" ||
      !a.text ||
      a.text.length > 200000
    )
      throw Error("Invalid predicted answer format.");
  if (
    new Set(p.answers.map((a) => a.start + ":" + a.end)).size !==
    p.answers.length
  )
    throw Error("Duplicate predicted answer spans.");
  for (const c of p.citations)
    if (
      !c ||
      typeof c.documentId !== "string" ||
      !Number.isInteger(c.paragraph) ||
      typeof c.quote !== "string" ||
      !c.quote ||
      c.quote.length > 200000
    )
      throw Error("Invalid predicted citation format.");
}
function evaluatePredictions(suite, predictions, options = {}) {
  const { documents, prompts: allPrompts, labels } = validateSuite(suite);
  const split = options.split || "test";
  if (!["test", "development"].includes(split))
    throw Error("Choose test or development split.");
  const prompts = new Map([...allPrompts].filter(([, p]) => p.split === split));
  if (!prompts.size) throw Error("No cases in the selected split.");
  const rows = uniqueBy(predictions, "id", "prediction");
  for (const [id, p] of rows) {
    const prompt = prompts.get(id);
    if (!prompt)
      throw Error(
        "Prediction identifier is outside the selected evaluation split.",
      );
    validatePrediction(p, prompt, documents.get(prompt.documentId));
  }
  let answerable = 0,
    unanswerable = 0,
    truePositive = 0,
    falsePositive = 0,
    trueNegative = 0,
    falseNegative = 0,
    missingAnswerable = 0,
    missingUnanswerable = 0,
    exact = 0,
    f1Sum = 0,
    answerableExact = 0,
    answerableF1 = 0,
    providedCitations = 0,
    validCitations = 0,
    invalidAnswerSpans = 0,
    answered = 0,
    answersWithCitation = 0,
    goldSpans = 0,
    coveredGoldSpans = 0,
    overlapCharacters = 0,
    goldCharacters = 0;
  const cases = [];
  for (const [id, prompt] of prompts) {
    const gold = labels.get(id),
      p = rows.get(id),
      document = documents.get(prompt.documentId);
    gold.answerable ? answerable++ : unanswerable++;
    goldSpans += gold.answers.length;
    goldCharacters += gold.answers.reduce((n, a) => n + a.end - a.start, 0);
    if (!p) {
      gold.answerable ? missingAnswerable++ : missingUnanswerable++;
      cases.push({
        id,
        category: prompt.category,
        status: "missing_prediction",
        exactMatch: 0,
        tokenF1: 0,
      });
      continue;
    }
    const verifiedAnswers = p.answers.filter(
      (a) =>
        a.start >= 0 &&
        a.end > a.start &&
        a.end <= document.text.length &&
        document.text.slice(a.start, a.end) === a.text,
    );
    invalidAnswerSpans += p.answers.length - verifiedAnswers.length;
    const spans = paragraphRanges(document.text);
    const checkedCitations = p.citations.map((c) => {
      const paragraph = spans[c.paragraph - 1];
      const index = paragraph?.text.indexOf(c.quote) ?? -1;
      return {
        ...c,
        valid: c.documentId === document.id && !!paragraph && index >= 0,
        start: index >= 0 ? paragraph.start + index : -1,
        end: index >= 0 ? paragraph.start + index + c.quote.length : -1,
      };
    });
    providedCitations += checkedCitations.length;
    validCitations += checkedCitations.filter((c) => c.valid).length;
    const valid = checkedCitations.filter((c) => c.valid);
    if (!p.abstained) {
      answered++;
      if (
        verifiedAnswers.length === p.answers.length &&
        verifiedAnswers.every((a) =>
          valid.some((c) => c.start <= a.start && c.end >= a.end),
        )
      )
        answersWithCitation++;
    }
    if (gold.answerable) {
      if (p.abstained) falseNegative++;
      else truePositive++;
    } else if (p.abstained) trueNegative++;
    else falsePositive++;
    const key = (a) => a.start + ":" + a.end;
    const predictedSet = new Set(p.answers.map(key)),
      goldSet = new Set(gold.answers.map(key));
    const em = Number(
      verifiedAnswers.length === p.answers.length &&
        predictedSet.size === goldSet.size &&
        [...goldSet].every((s) => predictedSet.has(s)),
    );
    const f1 = p.abstained
      ? Number(!gold.answerable)
      : gold.answerable && verifiedAnswers.length === p.answers.length
        ? tokenF1(
            gold.answers.map((a) => a.text).join("\n"),
            p.answers.map((a) => a.text).join("\n"),
          )
        : 0;
    exact += em;
    f1Sum += f1;
    if (gold.answerable) {
      answerableExact += em;
      answerableF1 += f1;
    }
    let caseCovered = 0;
    for (const g of gold.answers) {
      if (valid.some((c) => c.start <= g.start && c.end >= g.end)) {
        coveredGoldSpans++;
        caseCovered++;
      }
      const intervals = valid
        .map((c) => [Math.max(g.start, c.start), Math.min(g.end, c.end)])
        .filter(([a, b]) => a < b)
        .sort((a, b) => a[0] - b[0]);
      let end = -1;
      for (const [a, b] of intervals) {
        overlapCharacters += Math.max(0, b - Math.max(a, end));
        end = Math.max(end, b);
      }
    }
    cases.push({
      id,
      category: prompt.category,
      status: "scored",
      expectedAnswerable: gold.answerable,
      predictedAnswerable: !p.abstained,
      exactMatch: em,
      tokenF1: f1,
      invalidAnswerSpans: p.answers.length - verifiedAnswers.length,
      citations: checkedCitations.length,
      validCitations: valid.length,
      coveredGoldSpans: caseCovered,
      goldSpans: gold.answers.length,
    });
  }
  const n = prompts.size;
  return {
    evaluation: "counsel-contract-extraction-v1",
    status: rows.size === n ? "complete" : "incomplete",
    dataset: suite.manifest.dataset,
    suiteFingerprint: sha256(JSON.stringify(suite.manifest)),
    split,
    cases: n,
    providedPredictions: rows.size,
    missingPredictions: n - rows.size,
    predictionCoverage: rows.size / n,
    answerableCases: answerable,
    unanswerableCases: unanswerable,
    spanExactMatch: exact / n,
    tokenF1: f1Sum / n,
    answerableSpanExactMatch: ratio(answerableExact, answerable),
    answerableTokenF1: ratio(answerableF1, answerable),
    answerability: {
      truePositive,
      falsePositive,
      trueNegative,
      falseNegative,
      missingAnswerable,
      missingUnanswerable,
      precision: ratio(truePositive, truePositive + falsePositive),
      recall: ratio(truePositive, answerable),
      correctAbstentionRate: ratio(trueNegative, unanswerable),
      balancedAccuracy:
        answerable && unanswerable
          ? (truePositive / answerable + trueNegative / unanswerable) / 2
          : null,
      falseAnswerRateOnUnanswerable: ratio(falsePositive, unanswerable),
    },
    citations: {
      provided: providedCitations,
      valid: validCitations,
      exactReferencePrecision: ratio(validCitations, providedCitations),
      fullyCitedAnswerRate: ratio(answersWithCitation, answered),
      invalidAnswerSpans,
    },
    retrieval: {
      goldSpans,
      fullyCoveredGoldSpans: coveredGoldSpans,
      goldSpanRecall: ratio(coveredGoldSpans, goldSpans),
      goldCharacterCoverage: ratio(overlapCharacters, goldCharacters),
    },
    limitations: [
      suite.manifest.limitations,
      "Answerability measures deciding whether any clause exists, not whether the extracted answer is correct. Exact match requires every annotated span; token F1 compares all annotated text using normalized English-style tokens. Missing predictions score zero, including unanswerable cases.",
      "Reference precision verifies quote/source integrity, not claim entailment. Retrieved-passage baselines are not generated legal analysis. No result establishes legal correctness, jurisdiction coverage, deployment safety, or superiority over Legora.",
    ],
    results: cases,
  };
}
module.exports = { tokens, tokenF1, evaluatePredictions };
