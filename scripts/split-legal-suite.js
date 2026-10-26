// Derives document-disjoint development and validation suites from a larger
// legal evaluation suite. Documents are ordered by identifier so the split is
// reproducible and fixed before any metric is inspected.
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { readSuite, writeSuite } = require("../evaluation/suite");

function derive(suite, developmentCount) {
  const documents = [...suite.documents].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  if (documents.length < 3)
    throw Error("At least three source documents are required.");
  const count = Math.min(Math.max(1, developmentCount), documents.length - 1);
  const development = new Set(documents.slice(0, count).map((d) => d.id));
  const splitFor = (documentId) =>
    development.has(documentId) ? "development" : "test";
  const make = (selected) => {
    const ids = new Set(selected.map((d) => d.id));
    return {
      manifest: {
        ...suite.manifest,
        partitions: suite.manifest.partitions
          .filter((p) => ids.has(p.id))
          .map((p) => ({ ...p, split: splitFor(p.id) })),
        selectedDocuments: ids.size,
        selectedCases: suite.prompts.filter((p) => ids.has(p.documentId))
          .length,
      },
      documents: suite.documents
        .filter((d) => ids.has(d.id))
        .map((d) => ({ ...d, split: splitFor(d.id) })),
      prompts: suite.prompts
        .filter((p) => ids.has(p.documentId))
        .map((p) => ({ ...p, split: splitFor(p.documentId) })),
      labels: suite.labels
        .filter((l) => ids.has(l.documentId))
        .map((l) => ({ ...l, split: splitFor(l.documentId) })),
    };
  };
  return {
    development: make(documents.slice(0, count)),
    validation: make(documents.slice(count)),
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      suite: { type: "string" },
      out: { type: "string" },
      "development-documents": { type: "string" },
    },
  });
  if (!values.suite || !values.out)
    throw Error(
      "Usage: node scripts/split-legal-suite.js --suite DIRECTORY --out NEW_DIRECTORY [--development-documents 3]",
    );
  const out = path.resolve(values.out);
  if (fs.existsSync(out))
    throw Error("Output directory already exists; choose a new directory.");
  const count = Number(values["development-documents"] || 3);
  if (!Number.isInteger(count) || count < 1)
    throw Error("--development-documents must be a positive integer.");
  const suites = derive(readSuite(values.suite), count);
  fs.mkdirSync(out, { recursive: true });
  for (const [name, suite] of Object.entries(suites)) {
    const manifest = writeSuite(path.join(out, name), suite);
    console.log(
      JSON.stringify({
        split: name,
        directory: path.join(out, name),
        documents: suite.documents.length,
        cases: suite.prompts.length,
        developmentDocuments: manifest.partitions.filter(
          (p) => p.split === "development",
        ).length,
        testDocuments: manifest.partitions.filter((p) => p.split === "test")
          .length,
      }),
    );
  }
}

if (require.main === module) main();

module.exports = { derive };
