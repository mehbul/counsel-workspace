const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { readZip } = require("../zip");

const REQUIRED = [
  "README.txt",
  "manifest.json",
  "SHA256SUMS",
  "matter/matter.json",
  "matter/documents.json",
  "matter/drafts.json",
  "matter/originals.json",
  "matter/audit.json",
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const pathKey = (value) => value.normalize("NFC").toLowerCase();

function fail(message) {
  throw Error(message);
}

function parseChecksums(value) {
  const checksums = new Map();
  for (const line of value.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) fail("SHA256SUMS contains a malformed line.");
    const key = pathKey(match[2]);
    if (checksums.has(key)) fail("SHA256SUMS contains a duplicate path.");
    checksums.set(key, { path: match[2], hash: match[1] });
  }
  return checksums;
}

function parseJson(files, name) {
  try {
    return JSON.parse(files.get(name).data.toString("utf8"));
  } catch {
    fail(`${name} is not valid JSON.`);
  }
}

function verifyFile(files, path, expected) {
  const file = files.get(path);
  if (!file) fail(`Missing archive file: ${path}`);
  if (
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes !== file.data.length
  )
    fail(`${path} has an unexpected size.`);
  if (expected.sha256 !== digest(file.data))
    fail(`${path} does not match its recorded SHA-256.`);
}

function verifyArchive(buffer) {
  const entries = readZip(buffer, { maxBytes: 1024 * 1024 * 1024 }),
    files = new Map(entries.map((entry) => [entry.name, entry]));
  if (files.size !== entries.length) fail("Archive contains duplicate files.");
  for (const name of REQUIRED)
    if (!files.has(name)) fail(`Missing required archive file: ${name}`);
  const checksums = parseChecksums(
    files.get("SHA256SUMS").data.toString("utf8"),
  );
  for (const entry of entries) {
    if (entry.name === "SHA256SUMS") continue;
    const expected = checksums.get(pathKey(entry.name));
    if (!expected || expected.path !== entry.name)
      fail(`SHA256SUMS does not cover ${entry.name}.`);
    if (expected.hash !== digest(entry.data))
      fail(`${entry.name} does not match SHA256SUMS.`);
  }
  for (const [key, checksum] of checksums)
    if (key === pathKey("SHA256SUMS") || !files.has(checksum.path))
      fail(`SHA256SUMS references a missing file: ${checksum.path}`);

  const manifest = parseJson(files, "manifest.json"),
    matter = parseJson(files, "matter/matter.json");
  if (!manifest || typeof manifest !== "object")
    fail("manifest.json is invalid.");
  if (manifest.format !== "counsel-matter-archive")
    fail("The archive format is not recognized.");
  if (manifest.version !== 1)
    fail(`Unsupported archive version: ${manifest.version}`);
  if (!Number.isFinite(Date.parse(manifest.generatedAt)))
    fail("The archive timestamp is invalid.");
  if (!manifest.matter?.id || matter.id !== manifest.matter.id)
    fail("The manifest does not match the archived matter.");
  if (
    manifest.matter.name !== undefined &&
    manifest.matter.name !== matter.name
  )
    fail("The manifest matter name does not match the archived matter.");
  if (
    !["metadata", "full"].includes(manifest.mode) ||
    manifest.originalsIncluded !== (manifest.mode === "full")
  )
    fail("The archive mode is inconsistent.");
  if (!Array.isArray(manifest.files))
    fail("The manifest file list is invalid.");
  if (!files.get("README.txt").data.length) fail("README.txt is empty.");

  const listed = new Map(),
    listedKeys = new Set();
  let listedBytes = 0;
  for (const item of manifest.files) {
    if (
      !item ||
      typeof item.path !== "string" ||
      item.path === "manifest.json" ||
      item.path === "SHA256SUMS" ||
      listedKeys.has(pathKey(item.path))
    )
      fail("The manifest file list is invalid.");
    listed.set(item.path, item);
    listedKeys.add(pathKey(item.path));
    listedBytes += item.bytes;
    verifyFile(files, item.path, item);
  }
  for (const entry of entries)
    if (entry.name !== "manifest.json" && entry.name !== "SHA256SUMS")
      if (!listed.has(entry.name))
        fail(`The manifest does not list ${entry.name}.`);

  const counts = manifest.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts))
    fail("The manifest counts are invalid.");
  if (
    !Number.isSafeInteger(counts.listedFiles) ||
    counts.listedFiles !== manifest.files.length
  )
    fail("The manifest listed-file count is inconsistent.");
  if (
    !Number.isSafeInteger(counts.listedBytes) ||
    counts.listedBytes !== listedBytes
  )
    fail("The manifest listed-byte count is inconsistent.");
  if (
    !Number.isSafeInteger(counts.archiveFiles) ||
    counts.archiveFiles !== entries.length
  )
    fail("The manifest archive-file count is inconsistent.");

  const documentIds = new Set(),
    payloadPaths = new Map();
  function payloadPath(value, prefix, label) {
    if (typeof value !== "string" || !value.startsWith(prefix))
      fail(`${label} must be archived under ${prefix}.`);
    const key = pathKey(value);
    if (payloadPaths.has(key))
      fail(`Archive payload path is duplicated: ${value}`);
    payloadPaths.set(key, label);
    if (!files.has(value)) fail(`Missing archive file: ${value}`);
    if (!listed.has(value)) fail(`The manifest does not list ${value}.`);
  }

  const documents = parseJson(files, "matter/documents.json");
  if (!Array.isArray(documents)) fail("matter/documents.json is invalid.");
  for (const document of documents) {
    if (typeof document?.id !== "string" || !document.id)
      fail("A document has no ID.");
    if (documentIds.has(document.id))
      fail(`Document ID is duplicated: ${document.id}`);
    documentIds.add(document.id);
    payloadPath(
      document.archive?.textPath,
      "documents/",
      "A document text path",
    );
    verifyFile(files, document.archive.textPath, document.archive);
  }

  const draftIds = new Set();
  const drafts = parseJson(files, "matter/drafts.json");
  if (!Array.isArray(drafts)) fail("matter/drafts.json is invalid.");
  for (const draft of drafts) {
    if (typeof draft?.id !== "string" || !draft.id) fail("A draft has no ID.");
    if (draftIds.has(draft.id)) fail(`Draft ID is duplicated: ${draft.id}`);
    draftIds.add(draft.id);
    payloadPath(draft.archive?.textPath, "drafts/", "A draft text path");
    verifyFile(files, draft.archive.textPath, draft.archive);
  }

  const skillFile = files.get("matter/skills.json");
  if (skillFile) {
    const skills = parseJson(files, "matter/skills.json");
    if (!Array.isArray(skills)) fail("matter/skills.json is invalid.");
    for (const skill of skills)
      if (
        typeof skill?.id !== "string" ||
        !skill.id ||
        typeof skill.name !== "string" ||
        typeof skill.instructions !== "string"
      )
        fail("A referenced workflow skill has invalid metadata.");
  }

  const originals = parseJson(files, "matter/originals.json"),
    originalEntries = entries.filter((entry) =>
      entry.name.startsWith("originals/"),
    );
  if (
    !originals ||
    typeof originals.included !== "boolean" ||
    !Array.isArray(originals.retained)
  )
    fail("matter/originals.json is invalid.");
  if (originals.included !== manifest.originalsIncluded)
    fail("The archive mode disagrees with originals.json.");
  const retainedIds = new Set(),
    retainedPaths = new Set();
  for (const original of originals.retained) {
    if (
      !original ||
      typeof original.documentId !== "string" ||
      !original.documentId ||
      typeof original.name !== "string" ||
      typeof original.mime !== "string" ||
      !/^[a-f0-9]{64}$/.test(original.sha256 || "") ||
      !Number.isSafeInteger(original.bytes) ||
      original.bytes < 0
    )
      fail("A retained original has invalid metadata.");
    if (!documentIds.has(original.documentId))
      fail("A retained original is not attached to an archived document.");
    if (retainedIds.has(original.documentId))
      fail(`Original file is duplicated: ${original.documentId}`);
    retainedIds.add(original.documentId);
    if (manifest.originalsIncluded) {
      payloadPath(original.path, "originals/", "A retained original path");
      retainedPaths.add(original.path);
      verifyFile(files, original.path, original);
    } else if (original.path !== null)
      fail("A metadata-only archive records an original path.");
  }
  if (
    !Number.isSafeInteger(counts.originalsRetained) ||
    counts.originalsRetained !== originals.retained.length
  )
    fail("The manifest original count is inconsistent.");
  if (
    !Number.isSafeInteger(counts.originalsMissing) ||
    counts.originalsMissing !==
      documents.filter((document) => !retainedIds.has(document.id)).length
  )
    fail("The manifest missing-original count is inconsistent.");
  if (manifest.originalsIncluded) {
    if (!originals.retained.length)
      fail("A full archive contains no retained originals.");
    if (originalEntries.length !== originals.retained.length)
      fail("The archived original count disagrees with originals.json.");
    for (const entry of originalEntries)
      if (!retainedPaths.has(entry.name))
        fail(`originals.json does not describe ${entry.name}.`);
  } else if (originalEntries.length)
    fail("Originals are present in a metadata-only archive.");
  if (
    Array.isArray(originals.unavailableDocumentIds) &&
    originals.unavailableDocumentIds.some((id) => !documentIds.has(id))
  )
    fail("originals.json lists an unknown document.");
  if (
    !Number.isSafeInteger(counts.documents) ||
    counts.documents !== documents.length
  )
    fail("The manifest document count is inconsistent.");
  if (!Number.isSafeInteger(counts.drafts) || counts.drafts !== drafts.length)
    fail("The manifest draft count is inconsistent.");

  const audit = parseJson(files, "matter/audit.json");
  if (
    !audit ||
    typeof audit.available !== "boolean" ||
    !Array.isArray(audit.rows)
  )
    fail("matter/audit.json is invalid.");
  if (!audit.available && audit.rows.length)
    fail("Unavailable audit records contain rows.");
  if (
    !Number.isSafeInteger(counts.auditRows) ||
    counts.auditRows !== audit.rows.length
  )
    fail("The manifest audit-row count is inconsistent.");

  return {
    ok: true,
    format: manifest.format,
    version: manifest.version,
    mode: manifest.mode,
    matter: manifest.matter,
    generatedAt: manifest.generatedAt,
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.data.length, 0),
    documents: documents.length,
    drafts: drafts.length,
    originals: originals.retained.length,
    auditAvailable: audit.available,
    auditRows: audit.rows.length,
    sha256: digest(buffer),
  };
}

if (require.main === module) {
  const args = process.argv.slice(2),
    json = args.includes("--json"),
    file = args.find((arg) => arg !== "--json");
  if (!file) {
    console.error(
      "Usage: node scripts/verify-matter-archive.js <archive.zip> [--json]",
    );
    process.exitCode = 2;
  } else {
    try {
      const result = verifyArchive(fs.readFileSync(file));
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Verified ${file}`);
        console.log(`Matter: ${result.matter.name} (${result.matter.id})`);
        console.log(
          `Mode: ${result.mode}; files: ${result.files}; uncompressed bytes: ${result.bytes}`,
        );
        console.log(
          `Documents: ${result.documents}; drafts: ${result.drafts}; originals: ${result.originals}`,
        );
        console.log(
          `Audit: ${result.auditAvailable ? `${result.auditRows} row(s)` : "unavailable"}`,
        );
        console.log(`Archive SHA-256: ${result.sha256}`);
      }
    } catch (error) {
      console.error(`Archive verification failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = { verifyArchive };
