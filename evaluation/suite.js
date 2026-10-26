const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonl = (rows) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
function readJsonl(file) {
  const input = fs.readFileSync(file, "utf8");
  return input.split(/\r?\n/).flatMap((line, i) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      throw Error(`Invalid JSON on line ${i + 1} of ${path.basename(file)}.`);
    }
  });
}
function uniqueBy(rows, key, name) {
  const result = new Map();
  for (const row of rows) {
    if (!row || typeof row[key] !== "string" || !row[key])
      throw Error(`Invalid ${name} identifier.`);
    if (result.has(row[key])) throw Error(`Duplicate ${name} identifier.`);
    result.set(row[key], row);
  }
  return result;
}
function paragraphRanges(text) {
  const result = [];
  let start = 0;
  for (const match of text.matchAll(/\n\s*\n/g)) {
    result.push({
      start,
      end: match.index,
      text: text.slice(start, match.index),
    });
    start = match.index + match[0].length;
  }
  result.push({ start, end: text.length, text: text.slice(start) });
  return result;
}
function validateSuite(suite) {
  if (suite.manifest?.formatVersion !== 1)
    throw Error("Unknown evaluation format.");
  if (!Array.isArray(suite.manifest.partitions))
    throw Error("Missing document partitions.");
  const partitions = uniqueBy(
    suite.manifest.partitions,
    "id",
    "partition document",
  );
  const seenContent = new Map(),
    seenTitles = new Map();
  for (const row of partitions.values()) {
    if (!["development", "test"].includes(row.split))
      throw Error("Invalid document split.");
    if (!/^[a-f0-9]{64}$/.test(row.sha256))
      throw Error("Missing document content hash.");
    const title = String(row.title).normalize("NFKC").trim().toLowerCase();
    for (const [index, key] of [
      [seenContent, row.sha256],
      [seenTitles, title],
    ]) {
      if (index.has(key))
        throw Error("Document duplication or split leakage detected.");
      index.set(key, row.split);
    }
  }
  const documents = uniqueBy(suite.documents, "id", "source document");
  const prompts = uniqueBy(suite.prompts, "id", "prompt");
  const labels = uniqueBy(suite.labels, "id", "label");
  for (const d of documents.values()) {
    const partition = partitions.get(d.id);
    if (
      typeof d.text !== "string" ||
      sha256(d.text) !== d.sha256 ||
      !partition ||
      partition.sha256 !== d.sha256 ||
      partition.split !== d.split
    )
      throw Error("Source document hash or partition mismatch.");
  }
  const allowed = new Set([
    "id",
    "documentId",
    "documentSha256",
    "title",
    "question",
    "split",
    "category",
  ]);
  for (const p of prompts.values()) {
    if (Object.keys(p).some((key) => !allowed.has(key)))
      throw Error("Unexpected prompt fields; labels must remain separate.");
    const source = documents.get(p.documentId),
      label = labels.get(p.id);
    if (
      !source ||
      source.sha256 !== p.documentSha256 ||
      source.split !== p.split ||
      typeof p.question !== "string" ||
      !p.question.trim()
    )
      throw Error("Prompt source or split mismatch.");
    if (
      !label ||
      label.documentId !== p.documentId ||
      label.documentSha256 !== source.sha256 ||
      label.split !== p.split ||
      typeof label.answerable !== "boolean" ||
      !Array.isArray(label.answers) ||
      label.answerable !== label.answers.length > 0
    )
      throw Error("Label source or answerability mismatch.");
    for (const a of label.answers)
      if (
        !Number.isInteger(a.start) ||
        !Number.isInteger(a.end) ||
        a.start < 0 ||
        a.end <= a.start ||
        typeof a.text !== "string" ||
        source.text.slice(a.start, a.end) !== a.text
      )
        throw Error("Label answer does not match its exact source offset.");
  }
  if (labels.size !== prompts.size) throw Error("Unmatched labels or prompts.");
  return { documents, prompts, labels };
}
function writeSuite(directory, suite) {
  validateSuite(suite);
  const absolute = path.resolve(directory);
  if (fs.existsSync(absolute))
    throw Error(
      "Evaluation output directory already exists; choose a new directory.",
    );
  fs.mkdirSync(absolute, { recursive: true });
  const hashes = {};
  for (const name of ["documents", "prompts", "labels"]) {
    const text = jsonl(suite[name]);
    fs.writeFileSync(path.join(absolute, name + ".jsonl"), text, {
      flag: "wx",
      mode: 0o600,
    });
    hashes[name] = sha256(text);
  }
  const manifest = { ...suite.manifest, files: hashes };
  fs.writeFileSync(
    path.join(absolute, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return manifest;
}
function readSuite(directory) {
  const absolute = path.resolve(directory);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(absolute, "manifest.json"), "utf8"),
  );
  const result = { manifest };
  for (const name of ["documents", "prompts", "labels"]) {
    const file = path.join(absolute, name + ".jsonl");
    if (sha256(fs.readFileSync(file)) !== manifest.files?.[name])
      throw Error("Evaluation file hash mismatch: " + name);
    result[name] = readJsonl(file);
  }
  validateSuite(result);
  return result;
}
module.exports = {
  sha256,
  jsonl,
  readJsonl,
  uniqueBy,
  paragraphRanges,
  validateSuite,
  writeSuite,
  readSuite,
};
