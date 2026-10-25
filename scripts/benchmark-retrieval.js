const fixture = require("../test/fixtures/retrieval-benchmark.json");
const { retrieve } = require("../retrieval");
// Frozen copy of the prior server.js substring implementation, evaluated on the same source scope.
function baseline(query, docs) {
  const words = query.toLowerCase().match(/[a-z]{3,}/g) || [],
    stop = new Set([
      "the",
      "and",
      "for",
      "what",
      "are",
      "this",
      "with",
      "from",
      "that",
      "please",
      "across",
      "documents",
    ]),
    synonyms = {
      renewal: ["renew", "term"],
      liability: ["liability", "capped", "cap"],
      law: ["law", "jurisdiction"],
      assignment: ["assign"],
      termination: ["terminat", "breach"],
      confidentiality: ["confidential"],
      payment: ["fees", "pay", "invoice"],
    };
  const keys = [
    ...new Set(
      words
        .filter((w) => !stop.has(w))
        .flatMap((w) => [w, ...(synonyms[w] || [])]),
    ),
  ];
  return docs
    .filter((d) => !d.supersededBy)
    .flatMap((d) =>
      d.text.split(/\n\s*\n/).map((text, i) => ({
        documentId: d.id,
        name: d.name,
        paragraph: i + 1,
        text,
        score: keys.reduce(
          (n, w) => n + (text.toLowerCase().includes(w) ? 1 : 0),
          0,
        ),
      })),
    )
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}
function evaluate() {
  const results = fixture.cases.map((c) => {
    const docs = fixture.documents.filter((d) => c.documents.includes(d.id));
    const rank = (fn) => {
      const output = fn(c.query, docs, { limit: 3 }).slice(0, 3),
        index = output.findIndex((r) =>
          c.relevant.includes(r.documentId + ":" + r.paragraph),
        );
      return {
        rank: index < 0 ? null : index + 1,
        returned: output.length,
        top: output[0]
          ? output[0].documentId + ":" + output[0].paragraph
          : null,
      };
    };
    return {
      id: c.id,
      answerable: c.relevant.length > 0,
      baseline: rank(baseline),
      current: rank(retrieve),
    };
  });
  const summarize = (which) => {
    const answerable = results.filter((r) => r.answerable),
      missing = results.filter((r) => !r.answerable);
    return {
      answerableCases: answerable.length,
      missingEvidenceCases: missing.length,
      hitAt3:
        answerable.filter((r) => r[which].rank).length / answerable.length,
      mrrAt3:
        answerable.reduce(
          (sum, r) => sum + (r[which].rank ? 1 / r[which].rank : 0),
          0,
        ) / answerable.length,
      falsePositiveRate:
        missing.filter((r) => r[which].returned > 0).length / missing.length,
    };
  };
  return {
    benchmark: "synthetic-legal-retrieval-v1",
    description: fixture.description,
    baseline: summarize("baseline"),
    current: summarize("current"),
    cases: results,
  };
}
if (require.main === module) {
  const report = evaluate();
  console.log(JSON.stringify(report, null, 2));
  if (
    report.current.hitAt3 < report.baseline.hitAt3 + 0.15 ||
    report.current.mrrAt3 <= report.baseline.mrrAt3 ||
    report.current.falsePositiveRate > report.baseline.falsePositiveRate
  )
    process.exitCode = 1;
}
module.exports = { evaluate, baseline };
