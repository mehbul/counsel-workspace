const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { readSuite, readJsonl, jsonl } = require("../evaluation/suite");
const { evaluatePredictions } = require("../evaluation/scorer");
const { retrievalPredictions } = require("../evaluation/retrieval");

function main() {
  const { values } = parseArgs({
    options: {
      suite: { type: "string" },
      predictions: { type: "string" },
      mode: { type: "string" },
      split: { type: "string" },
      out: { type: "string" },
      "query-mode": { type: "string" },
    },
  });
  if (
    !values.suite ||
    !values.out ||
    !!values.predictions === (values.mode === "retrieval")
  )
    throw Error(
      "Usage: node scripts/evaluate-legal.js --suite DIRECTORY (--mode retrieval | --predictions FILE.jsonl) --out NEW_REPORT.json [--split test] [--query-mode full]",
    );
  const suite = readSuite(values.suite),
    split = values.split || "test";
  const output = path.resolve(values.out),
    predictionsFile = output + ".predictions.jsonl";
  if (
    fs.existsSync(output) ||
    (values.mode === "retrieval" && fs.existsSync(predictionsFile))
  )
    throw Error("Output already exists; use a new evaluation run name.");
  const predictions =
    values.mode === "retrieval"
      ? retrievalPredictions(
          { documents: suite.documents, prompts: suite.prompts },
          { split, queryMode: values["query-mode"] || "full" },
        )
      : readJsonl(values.predictions);
  const report = evaluatePredictions(suite, predictions, { split });
  report.runner =
    values.mode === "retrieval"
      ? {
          mode: "deterministic-retrieval",
          queryMode: values["query-mode"] || "full",
          passageLimit: 3,
          maxPassageCharacters: 3000,
          separateModelApiCalls: 0,
        }
      : {
          mode: "imported-predictions",
          file: path.basename(values.predictions),
        };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (values.mode === "retrieval")
    fs.writeFileSync(predictionsFile, jsonl(predictions), {
      flag: "wx",
      mode: 0o600,
    });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  const { results, dataset, ...summary } = report;
  console.log(JSON.stringify({ output, ...summary }, null, 2));
  if (report.status === "incomplete") process.exitCode = 2;
}
if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
module.exports = { main };
