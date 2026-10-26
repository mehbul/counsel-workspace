const { sha256, validateSuite } = require("./suite");

const SOURCE = {
  name: "CUAD v1",
  homepage: "https://www.atticusprojectai.org/cuad/",
  repository: "https://github.com/The-Atticus-Project/cuad",
  commit: "67faa0e6023b04fcaae6cc09497ab00e5d63a2a2",
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution:
    "The Atticus Project; Dan Hendrycks, Collin Burns, Anya Chen, Spencer Ball. CUAD: An Expert-Annotated NLP Dataset for Legal Contract Review (NeurIPS 2021).",
};
function offsetMap(text) {
  const map = [0];
  let offset = 0;
  for (const point of text) {
    offset += point.length;
    map.push(offset);
  }
  return map;
}
function contracts(payload, split) {
  if (!Array.isArray(payload?.data) || !payload.data.length)
    throw Error("CUAD input has no contracts.");
  return payload.data.map((item) => {
    if (
      typeof item.title !== "string" ||
      !item.title.trim() ||
      !Array.isArray(item.paragraphs) ||
      item.paragraphs.length !== 1
    )
      throw Error("CUAD contracts need a title and exactly one context.");
    const p = item.paragraphs[0];
    if (
      typeof p.context !== "string" ||
      !p.context ||
      !Array.isArray(p.qas) ||
      !p.qas.length
    )
      throw Error("Invalid CUAD context or questions.");
    const hash = sha256(p.context);
    return {
      id: "cuad-" + sha256(item.title + "\0" + hash).slice(0, 24),
      title: item.title,
      text: p.context,
      sha256: hash,
      split,
      qas: p.qas,
    };
  });
}
function bounded(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw Error("Invalid document sample size.");
  return value;
}
function buildCuadSuite({ train, test }, options = {}) {
  const seed = options.seed || "counsel-cuad-v1";
  if (typeof seed !== "string" || !seed.trim() || seed.length > 200)
    throw Error("Use a nonempty sample seed.");
  const inputs = [
    ...contracts(train, "development"),
    ...contracts(test, "test"),
  ];
  const seen = new Map(),
    excludedDuplicates = [],
    all = [];
  for (const d of inputs) {
    const previous = seen.get(d.sha256);
    if (previous) {
      if (previous.split !== d.split)
        throw Error("Document duplication or split leakage detected.");
      excludedDuplicates.push({
        title: d.title,
        sha256: d.sha256,
        split: d.split,
        keptDocumentId: previous.id,
      });
    } else {
      seen.set(d.sha256, d);
      all.push(d);
    }
  }
  const partitions = all.map(({ id, title, sha256, split }) => ({
    id,
    title,
    sha256,
    split,
  }));
  const documents = [],
    prompts = [],
    labels = [];
  const caps = {
    development: bounded(options.developmentDocuments, 0, 1000),
    test: bounded(options.testDocuments, 5, 1000),
  };
  const categories = options.categories;
  if (
    categories !== undefined &&
    (!Array.isArray(categories) ||
      !categories.length ||
      categories.some((c) => typeof c !== "string" || !c.trim()))
  )
    throw Error("Choose named CUAD question categories.");
  for (const split of ["development", "test"]) {
    const selected = all
      .filter((d) => d.split === split)
      .sort((a, b) => {
        const ah = sha256(seed + "\0" + a.id),
          bh = sha256(seed + "\0" + b.id);
        return ah.localeCompare(bh) || a.id.localeCompare(b.id);
      })
      .slice(0, caps[split]);
    for (const d of selected) {
      const { qas, ...source } = d;
      documents.push(source);
      const offsets = offsetMap(d.text);
      for (const qa of qas) {
        if (
          typeof qa.id !== "string" ||
          !qa.id ||
          typeof qa.question !== "string" ||
          !qa.question.trim() ||
          typeof qa.is_impossible !== "boolean" ||
          !Array.isArray(qa.answers) ||
          qa.is_impossible !== (qa.answers.length === 0)
        )
          throw Error("Invalid CUAD question or answerability annotation.");
        const category =
          qa.question.match(/related to "([^"]+)"/)?.[1] ||
          qa.id.split("__").at(-1);
        if (categories && !categories.includes(category)) continue;
        const id = "cuad-case-" + sha256(d.id + "\0" + qa.id).slice(0, 32);
        prompts.push({
          id,
          documentId: d.id,
          documentSha256: d.sha256,
          title: d.title,
          question: qa.question,
          category,
          split,
        });
        const answers = qa.answers.map((a) => {
          if (
            !Number.isInteger(a.answer_start) ||
            a.answer_start < 0 ||
            a.answer_start >= offsets.length ||
            typeof a.text !== "string" ||
            !a.text
          )
            throw Error("Invalid CUAD answer offset.");
          const start = offsets[a.answer_start],
            end = start + a.text.length;
          if (d.text.slice(start, end) !== a.text)
            throw Error("CUAD answer offset does not match its context.");
          return { start, end, text: a.text };
        });
        labels.push({
          id,
          documentId: d.id,
          documentSha256: d.sha256,
          split,
          answerable: !qa.is_impossible,
          answers,
        });
      }
    }
  }
  if (!prompts.some((p) => p.split === "test"))
    throw Error("No test prompts selected.");
  const inputSha256 = options.inputSha256 || {
    train: sha256(JSON.stringify(train)),
    test: sha256(JSON.stringify(test)),
  };
  const suite = {
    manifest: {
      formatVersion: 1,
      dataset: {
        ...SOURCE,
        inputSha256,
        pinnedInputsVerified:
          inputSha256.train ===
            "7de21d2bb741ac939e2a839ef9640634a5e0f9f40ea2b82c6833baf7db33dab4" &&
          inputSha256.test ===
            "007b6a40b0c65247f881627375c3d2e9b6aeeb5dfa89957494feed0765a1a073",
      },
      splitMethod:
        "Official CUAD train/test documents; deterministic seeded document sampling within each partition.",
      selection: {
        seed,
        requestedDocuments: caps,
        categories: categories || null,
      },
      offsetUnit:
        "UTF-16 code units; imported CUAD code-point offsets are converted without changing source text.",
      partitions,
      excludedDuplicates,
      selectedDocuments: documents.length,
      selectedCases: prompts.length,
      limitations:
        "This is an externally annotated contract-extraction evaluation, not a legal-advice or Legora benchmark. Public-data model training contamination cannot be excluded. Once inspected or tuned against, this test sample is no longer a fresh held-out set.",
    },
    documents,
    prompts,
    labels,
  };
  validateSuite(suite);
  return suite;
}
module.exports = { SOURCE, offsetMap, buildCuadSuite };
