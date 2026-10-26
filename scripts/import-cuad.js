const fs = require("node:fs");
const { parseArgs } = require("node:util");
const { buildCuadSuite } = require("../evaluation/cuad");
const { sha256, writeSuite } = require("../evaluation/suite");

function main() {
  const { values } = parseArgs({
    options: {
      train: { type: "string" },
      test: { type: "string" },
      out: { type: "string" },
      seed: { type: "string" },
      "test-documents": { type: "string" },
      "development-documents": { type: "string" },
      categories: { type: "string" },
    },
  });
  if (!values.train || !values.test || !values.out)
    throw Error(
      "Usage: node scripts/import-cuad.js --train train_separate_questions.json --test test.json --out NEW_DIRECTORY [--test-documents 5] [--development-documents 0] [--seed SEED] [--categories 'Governing Law,Anti-Assignment']",
    );
  const rawTrain = fs.readFileSync(values.train),
    rawTest = fs.readFileSync(values.test);
  const suite = buildCuadSuite(
    { train: JSON.parse(rawTrain), test: JSON.parse(rawTest) },
    {
      seed: values.seed,
      testDocuments:
        values["test-documents"] === undefined
          ? undefined
          : Number(values["test-documents"]),
      developmentDocuments:
        values["development-documents"] === undefined
          ? undefined
          : Number(values["development-documents"]),
      categories: values.categories?.split(",").map((x) => x.trim()),
      inputSha256: { train: sha256(rawTrain), test: sha256(rawTest) },
    },
  );
  const manifest = writeSuite(values.out, suite);
  console.log(
    JSON.stringify(
      {
        status: "prepared",
        output: values.out,
        documents: manifest.selectedDocuments,
        cases: manifest.selectedCases,
        splitMethod: manifest.splitMethod,
        selection: manifest.selection,
        inputSha256: manifest.dataset.inputSha256,
      },
      null,
      2,
    ),
  );
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
