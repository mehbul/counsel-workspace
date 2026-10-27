const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.COUNSEL_DB = ":memory:";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "counsel-archive-"),
);
process.env.AI_PROVIDER = "evidence";

const {
  app,
  db,
  jobs,
  notifications,
  workflows,
  research,
} = require("../server");
const { createMatterArchive, safeName } = require("../matter-archive");
const { readZip, buildZip, safeArchivePath } = require("../zip");
const { verifyArchive } = require("../scripts/verify-matter-archive");

const digest = (value) => createHash("sha256").update(value).digest("hex");

function client() {
  return {
    cookie: "",
    csrf: "",
    async req(p, b, method = b ? "POST" : "GET") {
      const response = await fetch(`http://127.0.0.1:${this.port}/api/${p}`, {
        method,
        headers: {
          Cookie: this.cookie,
          "X-CSRF-Token": this.csrf,
          ...(b instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body:
          b instanceof FormData
            ? b
            : b === undefined
              ? undefined
              : JSON.stringify(b),
      });
      if (response.headers.get("set-cookie"))
        this.cookie = response.headers.get("set-cookie").split(";")[0];
      const data = await response.json();
      if (data.csrf) this.csrf = data.csrf;
      return { status: response.status, data, headers: response.headers };
    },
  };
}

test("matter archives are scoped, checksummed and optionally include originals", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
  });
  const port = server.address().port;
  t.after(async () => {
    await notifications.close();
    await workflows.close();
    await research.close();
    await jobs.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const owner = client(),
    editor = client(),
    viewer = client();
  owner.port = editor.port = viewer.port = port;
  await owner.req("auth/setup", {
    token: fs.readFileSync(
      path.join(process.env.DATA_DIR, "bootstrap-token"),
      "utf8",
    ),
    email: "owner@archive.test",
    password: "Owner archive test passphrase",
    workspace: "Archive test",
  });
  for (const [role, email] of [
    ["editor", "editor@archive.test"],
    ["viewer", "viewer@archive.test"],
  ])
    assert.equal(
      (
        await owner.req("admin/users", {
          email,
          password: `${role} archive test passphrase`,
          role,
        })
      ).status,
      200,
    );
  const createdUsers = (await owner.req("admin/users")).data,
    editorUser = createdUsers.find(
      (user) => user.email === "editor@archive.test",
    ),
    viewerUser = createdUsers.find(
      (user) => user.email === "viewer@archive.test",
    );
  assert.ok(editorUser);
  assert.ok(viewerUser);
  for (const [account, email] of [
    [editor, "editor@archive.test"],
    [viewer, "viewer@archive.test"],
  ])
    assert.equal(
      (
        await account.req("auth/login", {
          email,
          password: `${email.split("@")[0]} archive test passphrase`,
        })
      ).status,
      200,
    );

  const initial = (await owner.req("state")).data,
    matterId = initial.matters[0].id,
    originalText =
      "ARCHIVE ORIGINAL\n\nGoverning law: England and Wales.\nLiability cap: GBP 500,000.\n";
  const upload = new FormData();
  upload.append("matterId", matterId);
  upload.append(
    "files",
    new Blob([originalText], { type: "text/plain" }),
    "Archive source.txt",
  );
  const imported = await owner.req("documents", upload);
  assert.equal(imported.status, 200);
  assert.equal(imported.data[0].name, "Archive source.txt");
  assert.ok(imported.data[0].original.sha256);
  const documentId = imported.data[0].id;
  assert.equal(
    (
      await owner.req("tasks", {
        matterId,
        title: "Archive task",
      })
    ).status,
    200,
  );
  const draft = await owner.req("drafts", {
    matterId,
    title: "Archive memorandum",
    prompt: "Summarize the governing law",
    documentIds: [documentId],
  });
  assert.equal(draft.status, 200);

  const ownerRow = db
    .prepare("SELECT * FROM users WHERE email=?")
    .get("owner@archive.test");
  const skill = initial.skills[0],
    templateId = "00000000-0000-4000-8000-00000000a001",
    runId = "00000000-0000-4000-8000-00000000a002";
  assert.ok(skill);
  db.prepare("INSERT INTO workflow_templates VALUES(?,?,?,?,?)").run(
    templateId,
    ownerRow.workspace_id,
    JSON.stringify({
      name: "Archive workflow",
      description: "Referenced skill fixture",
      steps: [{ kind: "search", name: "Search", skillId: skill.id }],
    }),
    1,
    new Date().toISOString(),
  );
  db.prepare("INSERT INTO workflow_runs VALUES(?,?,?,?,?,?,?,?)").run(
    runId,
    ownerRow.workspace_id,
    ownerRow.id,
    matterId,
    templateId,
    JSON.stringify({
      id: runId,
      templateVersion: 1,
      steps: [{ kind: "search", name: "Search", skillId: skill.id }],
    }),
    "completed",
    new Date().toISOString(),
  );
  const orphanBytes = Buffer.from("orphaned original");
  db.prepare("INSERT INTO document_originals VALUES(?,?,?,?,?,?,?)").run(
    ownerRow.workspace_id,
    "00000000-0000-4000-8000-00000000a003",
    matterId,
    "Orphaned.pdf",
    "application/pdf",
    digest(orphanBytes),
    orphanBytes,
  );
  db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)").run(
    "archive-audit-row",
    ownerRow.workspace_id,
    ownerRow.id,
    "matter.reviewed",
    matterId,
    new Date().toISOString(),
  );
  db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)").run(
    "archive-audit-row-2",
    ownerRow.workspace_id,
    ownerRow.id,
    "matter.updated",
    matterId,
    new Date(Date.now() + 1).toISOString(),
  );
  assert.equal(
    (
      await owner.req("admin/access", {
        userId: editorUser.id,
        matterId,
        allowed: true,
      })
    ).status,
    200,
  );

  const preview = await owner.req(`matters/${matterId}/archive/preview`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.format, "counsel-matter-archive");
  assert.equal(preview.data.metadata.documents, 4);
  assert.equal(preview.data.metadata.drafts, 1);
  assert.equal(preview.data.metadata.originalsRetained, 1);
  assert.equal(preview.data.metadata.workflowRuns, 1);
  assert.equal(preview.data.metadata.workflowTemplates, 1);
  assert.equal(preview.data.metadata.skills, 1);
  assert.equal(preview.data.metadata.skillsMissing, 0);
  assert.equal(preview.data.metadata.audit.available, true);
  assert.ok(preview.data.metadata.auditRows >= 2);
  assert.ok(
    preview.data.warnings.some((warning) =>
      /no longer referenced by a current document/.test(warning),
    ),
  );
  assert.equal(preview.data.full.available, true);
  assert.equal(preview.data.full.exceedsLimit, false);
  assert.ok(preview.data.full.bytes > preview.data.metadata.bytes);
  assert.ok(preview.data.metadata.auditRows >= 1);

  assert.equal(
    (await owner.req(`matters/${matterId}/archive?originals=maybe`)).status,
    400,
  );
  assert.equal(
    (
      await owner.req(
        "matters/00000000-0000-4000-8000-000000000000/archive/preview",
      )
    ).status,
    404,
  );

  async function download(account, query = "") {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/matters/${matterId}/archive${query}`,
      { headers: { Cookie: account.cookie } },
    );
    return {
      response,
      buffer:
        response.status === 200
          ? Buffer.from(await response.arrayBuffer())
          : null,
      body: response.status === 200 ? null : await response.json(),
    };
  }

  const metadata = await download(owner);
  assert.equal(metadata.response.status, 200);
  assert.equal(
    metadata.response.headers.get("cache-control"),
    "private, no-store",
  );
  assert.equal(
    metadata.response.headers.get("content-type"),
    "application/zip",
  );
  assert.match(
    metadata.response.headers.get("content-disposition"),
    /attachment; filename="counsel-.*-metadata\.zip"/,
  );
  assert.equal(
    metadata.response.headers.get("x-counsel-archive-sha256"),
    digest(metadata.buffer),
  );
  const metadataFiles = readZip(metadata.buffer),
    metadataByName = new Map(metadataFiles.map((entry) => [entry.name, entry])),
    metadataManifest = verifyArchive(metadata.buffer);
  assert.equal(metadataManifest.mode, "metadata");
  assert.equal(metadataManifest.matter.id, matterId);
  assert.ok(
    !metadataFiles.some((entry) => entry.name.startsWith("originals/")),
  );
  const metadataDocuments = JSON.parse(
    metadataByName.get("matter/documents.json").data.toString("utf8"),
  );
  assert.equal(metadataDocuments.length, 4);
  const archivedSource = metadataDocuments.find(
    (document) => document.id === documentId,
  );
  assert.ok(archivedSource.archive.textPath);
  assert.equal(
    metadataByName.get(archivedSource.archive.textPath).data.toString("utf8"),
    originalText,
  );
  const metadataOriginals = JSON.parse(
    metadataByName.get("matter/originals.json").data.toString("utf8"),
  );
  assert.equal(metadataOriginals.included, false);
  assert.equal(metadataOriginals.retained.length, 1);
  assert.equal(metadataOriginals.retained[0].path, null);
  assert.ok(
    !metadataOriginals.retained.some((item) => item.name === "Orphaned.pdf"),
  );
  const metadataSkills = JSON.parse(
    metadataByName.get("matter/skills.json").data.toString("utf8"),
  );
  assert.equal(metadataSkills.length, 1);
  assert.equal(metadataSkills[0].id, skill.id);
  assert.equal(metadataSkills[0].instructions, skill.instructions);
  assert.ok(
    JSON.parse(
      metadataByName.get("manifest.json").data.toString("utf8"),
    ).warnings.some((warning) =>
      /no longer referenced by a current document/.test(warning),
    ),
  );
  const ownerAudit = JSON.parse(
    metadataByName.get("matter/audit.json").data.toString("utf8"),
  );
  assert.equal(ownerAudit.available, true);
  assert.ok(ownerAudit.rows.some((row) => row.action === "matter.reviewed"));
  assert.match(
    metadataByName.get("README.txt").data.toString("utf8"),
    /sha256sum -c SHA256SUMS/,
  );
  const tamperedArchive = buildZip(
    metadataFiles.map((entry) => ({
      path: entry.name,
      data:
        entry.name === archivedSource.archive.textPath
          ? Buffer.concat([entry.data, Buffer.from("tampered")])
          : entry.data,
      store: entry.method === 0,
    })),
  );
  assert.throws(() => verifyArchive(tamperedArchive), /SHA-?256|checksum/i);

  const full = await download(owner, "?originals=1");
  assert.equal(full.response.status, 200);
  const fullFiles = readZip(full.buffer),
    fullByName = new Map(fullFiles.map((entry) => [entry.name, entry])),
    fullManifest = verifyArchive(full.buffer),
    fullOriginals = JSON.parse(
      fullByName.get("matter/originals.json").data.toString("utf8"),
    );
  assert.equal(fullManifest.mode, "full");
  assert.equal(fullManifest.files, fullFiles.length);
  assert.equal(fullOriginals.included, true);
  assert.ok(fullOriginals.retained[0].path);
  assert.deepEqual(
    fullByName.get(fullOriginals.retained[0].path).data,
    Buffer.from(originalText),
  );

  const editorPreview = await editor.req(`matters/${matterId}/archive/preview`);
  assert.equal(editorPreview.status, 200);
  assert.equal(editorPreview.data.metadata.originalsRetained, 1);
  const editorArchive = await download(editor);
  assert.equal(editorArchive.response.status, 200);
  const editorFiles = readZip(editorArchive.buffer),
    editorAudit = JSON.parse(
      new Map(editorFiles.map((entry) => [entry.name, entry]))
        .get("matter/audit.json")
        .data.toString("utf8"),
    );
  assert.equal(editorAudit.available, false);
  verifyArchive(editorArchive.buffer);

  assert.equal(
    (
      await owner.req("admin/access", {
        userId: viewerUser.id,
        matterId,
        allowed: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (await viewer.req(`matters/${matterId}/archive/preview`)).status,
    403,
  );
  assert.equal(
    (
      await fetch(
        `http://127.0.0.1:${port}/api/matters/${matterId}/archive/preview`,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await owner.req("admin/access", {
        userId: editorUser.id,
        matterId,
        allowed: false,
      })
    ).status,
    200,
  );
  assert.equal(
    (await editor.req(`matters/${matterId}/archive/preview`)).status,
    404,
  );

  const emptyMatter = await owner.req("matters", {
    name: "Empty archive matter",
  });
  assert.equal(emptyMatter.status, 200);
  const emptyPreview = await owner.req(
    `matters/${emptyMatter.data.id}/archive/preview`,
  );
  assert.equal(emptyPreview.status, 200);
  assert.equal(emptyPreview.data.full.available, false);
  const emptyMetadata = await fetch(
    `http://127.0.0.1:${port}/api/matters/${emptyMatter.data.id}/archive`,
    { headers: { Cookie: owner.cookie } },
  );
  assert.equal(emptyMetadata.status, 200);
  verifyArchive(Buffer.from(await emptyMetadata.arrayBuffer()));
  const emptyFull = await fetch(
    `http://127.0.0.1:${port}/api/matters/${emptyMatter.data.id}/archive?originals=1`,
    { headers: { Cookie: owner.cookie } },
  );
  assert.equal(emptyFull.status, 400);
  assert.match((await emptyFull.json()).error, /No retained original/);

  const snapshot = (await owner.req("state")).data,
    fake = {
      workspaceId: ownerRow.workspace_id,
      actor: ownerRow.id,
      role: "owner",
      state: snapshot,
      audit() {},
    };
  assert.throws(
    () =>
      createMatterArchive(db, () => fake, { maxOriginalBytes: 4 }).build(
        matterId,
        { originals: true },
      ),
    { status: 413 },
  );
  assert.throws(
    () =>
      createMatterArchive(db, () => fake, {
        maxMetadataBytes: 32,
      }).preview(matterId),
    { status: 413 },
  );
  assert.throws(
    () =>
      createMatterArchive(db, () => fake, {
        maxEntries: 8,
      }).preview(matterId),
    { status: 413 },
  );
  const truncated = createMatterArchive(db, () => fake, {
      maxAuditRows: 1,
    }).build(matterId),
    truncatedAudit = JSON.parse(
      new Map(readZip(truncated.buffer).map((entry) => [entry.name, entry]))
        .get("matter/audit.json")
        .data.toString("utf8"),
    );
  assert.equal(truncatedAudit.rows.length, 1);
  assert.equal(truncated.counts.auditRows, 1);
  assert.ok(
    truncated.warnings.some((warning) => /capped at 1 rows?/.test(warning)),
  );
  assert.equal(
    safeArchivePath("matter/documents.json"),
    "matter/documents.json",
  );
  assert.throws(() => safeArchivePath("../outside.txt"));
  assert.throws(() => safeArchivePath("C:/outside.txt"));
  assert.throws(() => safeArchivePath("matter//empty.txt"));
  assert.equal(safeName("../../client/secret.txt"), "-..-client-secret.txt");
  const longName = safeName("法".repeat(100));
  assert.equal(Array.from(longName).length, 60);
  assert.ok(Buffer.byteLength(longName, "utf8") <= 180);

  const mixedMatterId = "00000000-0000-4000-8000-00000000b001",
    mixedDocumentId = "00000000-0000-4000-8000-00000000b002",
    mixedBytes = Buffer.alloc(12_000, 0x78);
  db.prepare("INSERT INTO document_originals VALUES(?,?,?,?,?,?,?)").run(
    ownerRow.workspace_id,
    mixedDocumentId,
    mixedMatterId,
    "Mixed source.txt",
    "text/plain",
    digest(mixedBytes),
    mixedBytes,
  );
  const mixedContext = {
      workspaceId: ownerRow.workspace_id,
      actor: ownerRow.id,
      role: "owner",
      state: {
        matters: [{ id: mixedMatterId, name: "Mixed limits" }],
        documents: [
          {
            id: mixedDocumentId,
            matterId: mixedMatterId,
            name: "Mixed source.txt",
            text: "x".repeat(20_000),
          },
        ],
        messages: [],
        reviews: [],
        drafts: [],
        tasks: [],
        skills: [],
      },
      audit() {},
    },
    mixedPreview = createMatterArchive(db, () => mixedContext).preview(
      mixedMatterId,
    ),
    mixedMetadataLimit = mixedPreview.metadata.bytes + 1_000,
    mixed = createMatterArchive(db, () => mixedContext, {
      maxMetadataBytes: mixedMetadataLimit,
      maxOriginalBytes: 100_000,
    }).build(mixedMatterId, { originals: true });
  assert.equal(mixed.counts.originalsRetained, 1);
  verifyArchive(mixed.buffer);
});

test("matter archives restore on a fresh workspace with explicit side-effect and collision policy", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
  });
  const port = server.address().port;
  t.after(async () => {
    await notifications.close();
    await workflows.close();
    await research.close();
    await jobs.close();
    await new Promise((resolve) => server.close(resolve));
  });
  // The workspace already exists (auth/setup runs once per process, in the
  // first test). Restore targets this same workspace: the global fixture
  // identifiers below are unique, so the restore is still the only copy of
  // the matter, while the workspace content around it is realistic.
  const owner = client(),
    editor = client(),
    viewer = client(),
    guest = client();
  owner.port = editor.port = viewer.port = guest.port = port;
  await owner.req("auth/login", {
    email: "owner@archive.test",
    password: "Owner archive test passphrase",
  });
  for (const [role, email] of [
    ["editor", "restore-editor@archive.test"],
    ["viewer", "restore-viewer@archive.test"],
    ["guest", "restore-guest@archive.test"],
  ])
    assert.equal(
      (
        await owner.req("admin/users", {
          email,
          password: `${role} archive test passphrase`,
          role,
        })
      ).status,
      200,
    );
  for (const [account, email] of [
    [editor, "restore-editor@archive.test"],
    [viewer, "restore-viewer@archive.test"],
    [guest, "restore-guest@archive.test"],
  ])
    assert.equal(
      (
        await account.req("auth/login", {
          email,
          password: `${email.split("@")[0].split("-")[1]} archive test passphrase`,
        })
      ).status,
      200,
    );
  const ownerRow = db
    .prepare("SELECT * FROM users WHERE email=?")
    .get("owner@archive.test");
  assert.ok(ownerRow);

  // Build a rich source archive against a synthetic workspace to emulate a
  // fresh-instance restore: the target workspace below has never seen it.
  const sourceWorkspace = "ws-archive-source",
    matterId = "00000000-0000-4000-8000-00000000c001",
    documentId = "00000000-0000-4000-8000-00000000c002",
    supersededId = "00000000-0000-4000-8000-00000000c003",
    draftId = "00000000-0000-4000-8000-00000000c004",
    messageId = "00000000-0000-4000-8000-00000000c005",
    reviewId = "00000000-0000-4000-8000-00000000c006",
    taskId = "00000000-0000-4000-8000-00000000c007",
    runId = "00000000-0000-4000-8000-00000000c008",
    queuedJobId = "00000000-0000-4000-8000-00000000c009",
    doneJobId = "00000000-0000-4000-8000-00000000c00a",
    scheduleId = "00000000-0000-4000-8000-00000000c00b",
    templateId = "00000000-0000-4000-8000-00000000c00c",
    commentId = "00000000-0000-4000-8000-00000000c00d",
    checkpointId = "00000000-0000-4000-8000-00000000c00e",
    suggestionId = "00000000-0000-4000-8000-00000000c00f",
    comparisonId = "00000000-0000-4000-8000-00000000c010",
    watchId = "00000000-0000-4000-8000-00000000c011",
    operationId = "00000000-0000-4000-8000-00000000c012",
    publicationId = "00000000-0000-4000-8000-00000000c013",
    skillId = "00000000-0000-4000-8000-00000000c014";
  const sourceText =
    "SOURCE ORIGINAL\n\n1. Governing law. This agreement is governed by the laws of England and Wales.\n\n2. Liability. Aggregate liability is capped at GBP 500,000.\n";
  const sourceBytes = Buffer.from(sourceText),
    created = new Date().toISOString(),
    now = Date.now();
  db.prepare("INSERT INTO workflow_templates VALUES(?,?,?,?,?)").run(
    templateId,
    sourceWorkspace,
    JSON.stringify({
      name: "Archive restore workflow",
      description: "Fixture",
      steps: [{ kind: "search", name: "Search", skillId }],
    }),
    1,
    created,
  );
  db.prepare("INSERT INTO workflow_runs VALUES(?,?,?,?,?,?,?,?)").run(
    runId,
    sourceWorkspace,
    ownerRow.id,
    matterId,
    templateId,
    JSON.stringify({
      id: runId,
      templateId,
      templateVersion: 1,
      initiatorId: ownerRow.id,
      steps: [{ kind: "search", name: "Search", skillId }],
      status: "completed",
    }),
    "completed",
    created,
  );
  db.prepare(
    "INSERT INTO workflow_schedules VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    scheduleId,
    sourceWorkspace,
    ownerRow.id,
    matterId,
    templateId,
    JSON.stringify({ matterId, request: "Weekly contractual sweep" }),
    60,
    now + 60_000,
    1,
    null,
    null,
    created,
  );
  db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
    queuedJobId,
    sourceWorkspace,
    ownerRow.id,
    matterId,
    "draft",
    JSON.stringify({
      matterId,
      title: "Queued memo",
      documentIds: [documentId],
    }),
    "queued",
    null,
    null,
    created,
    created,
  );
  db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
    doneJobId,
    sourceWorkspace,
    ownerRow.id,
    matterId,
    "review",
    JSON.stringify({
      matterId,
      name: "Past review",
      documentIds: [documentId],
    }),
    "completed",
    JSON.stringify({ cells: 1 }),
    null,
    created,
    created,
  );
  db.prepare("INSERT INTO document_comparisons VALUES(?,?,?,?,?)").run(
    comparisonId,
    sourceWorkspace,
    matterId,
    JSON.stringify({
      summary: "No material differences.",
      matched: ["1"],
      documentIds: [documentId],
    }),
    created,
  );
  db.prepare("INSERT INTO research_watches VALUES(?,?,?,?,?,?,?)").run(
    watchId,
    sourceWorkspace,
    ownerRow.id,
    matterId,
    JSON.stringify({
      query: "assignment of agreements",
      provider: "federal-register",
    }),
    now + 60_000,
    1,
  );
  db.prepare("INSERT INTO legal_operations VALUES(?,?,?,?,?)").run(
    operationId,
    sourceWorkspace,
    matterId,
    "benchmark",
    JSON.stringify({ summary: "Fixture operation" }),
  );
  db.prepare(
    "INSERT INTO portal_publications VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    publicationId,
    sourceWorkspace,
    matterId,
    "Source summary",
    "document",
    documentId,
    digest(sourceBytes),
    "<p>HSR summary for the client.</p>",
    JSON.stringify([{ email: "client-guest@archive.test" }]),
    created,
    ownerRow.id,
    0,
  );
  db.prepare("INSERT INTO draft_comments VALUES(?,?,?,?,?,?,?)").run(
    commentId,
    sourceWorkspace,
    draftId,
    "Reviewer",
    "Cite the cap wording",
    0,
    created,
  );
  db.prepare("INSERT INTO draft_checkpoints VALUES(?,?,?,?,?,?,?)").run(
    checkpointId,
    sourceWorkspace,
    draftId,
    "Reviewer",
    "Early version",
    "Early draft body",
    created,
  );
  db.prepare("INSERT INTO draft_suggestions VALUES(?,?,?,?)").run(
    suggestionId,
    sourceWorkspace,
    draftId,
    JSON.stringify({ title: "Rename memorandum", rationale: "Fixture" }),
  );
  db.prepare("INSERT INTO document_originals VALUES(?,?,?,?,?,?,?)").run(
    sourceWorkspace,
    documentId,
    matterId,
    "Source original.txt",
    "text/plain",
    digest(sourceBytes),
    sourceBytes,
  );
  const sourceMatter = {
      id: matterId,
      name: "Archive restore source",
      client: "Fixture client",
      description: "Fixture matter for restore tests",
      created,
    },
    sourceDocuments = [
      {
        id: documentId,
        matterId,
        name: "Source original.txt",
        text: sourceText,
        pages: [{ page: 1, start: 0, end: sourceText.length }],
        ocr: false,
        created,
        original: { sha256: digest(sourceBytes), size: sourceBytes.length },
      },
      {
        id: supersededId,
        matterId,
        name: "Source original.txt",
        text: "Superseded earlier wording",
        pages: [],
        ocr: false,
        supersededBy: documentId,
        created,
      },
    ];
  function snapshot() {
    return {
      workspaceId: sourceWorkspace,
      actor: ownerRow.id,
      role: "owner",
      state: {
        matters: [sourceMatter],
        documents: sourceDocuments,
        messages: [
          {
            id: messageId,
            matterId,
            query: "What is the governing law?",
            text: "Clause 1 selects the laws of England and Wales.",
            citations: [],
            evidence: null,
            mode: "Local evidence search",
            created,
          },
        ],
        reviews: [
          {
            id: reviewId,
            matterId,
            name: "Source review",
            columns: ["Governing law", "Liability"],
            cells: [
              {
                id: "00000000-0000-4000-8000-00000000c015",
                documentId,
                column: 0,
                value: "England and Wales",
                status: "evidence_found",
                coverage: { ratio: 0.5 },
                citations: [],
                reviewed: false,
                locked: false,
              },
            ],
            created,
          },
        ],
        drafts: [
          {
            id: draftId,
            matterId,
            title: "Source memorandum",
            content: "The exported draft body.",
            mode: "Local evidence search",
            evidence: null,
            citations: [],
            created,
          },
        ],
        tasks: [
          {
            id: taskId,
            matterId,
            title: "Confirm governing law",
            status: "To do",
            owner: "Reviewer",
          },
        ],
        skills: [
          {
            id: skillId,
            name: "Fixture skill",
            category: "Custom",
            version: 1,
            instructions: "Point at assignment clauses only.",
          },
        ],
        activity: [],
      },
      audit() {},
    };
  }
  const sourceArchive = createMatterArchive(db, snapshot).build(matterId, {
      originals: true,
      now,
      identity: { userId: ownerRow.id, email: "", role: "owner" },
    }),
    sourceArchiveBuffer = sourceArchive.buffer;
  assert.equal(sourceArchive.counts.documents, 2);
  assert.equal(sourceArchive.counts.drafts, 1);
  assert.equal(sourceArchive.counts.jobs, 2);
  assert.equal(sourceArchive.counts.workflowSchedules, 1);
  assert.equal(sourceArchive.counts.skills, 1);
  assert.equal(sourceArchive.counts.originalsRetained, 1);
  // Emulate a fresh instance: drop the synthetic workspace's own rows so the
  // restore below is the only copy present in the database.
  for (const table of [
    "workflow_templates",
    "workflow_runs",
    "workflow_schedules",
    "jobs",
    "document_comparisons",
    "research_watches",
    "legal_operations",
    "portal_publications",
    "draft_comments",
    "draft_checkpoints",
    "draft_suggestions",
    "document_originals",
  ])
    db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(
      sourceWorkspace,
    );
  assert.equal(verifyArchive(sourceArchiveBuffer).matter.id, matterId);

  // Role gates on the restore route.
  assert.equal(
    (await editor.req("matters/archive/restore", new FormData())).status,
    403,
  );
  assert.equal(
    (await viewer.req("matters/archive/restore", new FormData())).status,
    403,
  );
  assert.equal(
    (await guest.req("matters/archive/restore", new FormData())).status,
    403,
  );
  const sendArchive = async (account, buffer, newIds) => {
    const form = new FormData();
    form.append(
      "archive",
      new Blob([buffer], { type: "application/zip" }),
      "restore.zip",
    );
    if (newIds !== undefined) form.append("newIds", newIds);
    return account.req("matters/archive/restore", form);
  };
  const tampered = Buffer.concat([sourceArchiveBuffer, Buffer.from("tail")]);
  assert.equal((await sendArchive(editor, tampered)).status, 403);
  // Unexpected file fields would fail in multer; owners must be checked first.
  const unexpectedUpload = new FormData();
  unexpectedUpload.append("unexpected", new Blob(["x"]), "unexpected.zip");
  assert.equal(
    (await editor.req("matters/archive/restore", unexpectedUpload)).status,
    403,
  );
  assert.equal((await sendArchive(owner, tampered)).status, 400);
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/api/matters/archive/restore`, {
        method: "POST",
      })
    ).status,
    401,
  );

  // Fail the final write after auxiliary rows and audit have been inserted.
  const beforeRestore = db
    .prepare("SELECT value FROM workspaces WHERE id=?")
    .get(ownerRow.workspace_id).value;
  const beforeAudit = db.prepare("SELECT COUNT(*) AS n FROM audit").get().n;
  const restoredTables = [
    "document_comparisons",
    "workflow_templates",
    "workflow_runs",
    "workflow_schedules",
    "legal_operations",
    "portal_publications",
    "jobs",
    "draft_comments",
    "draft_checkpoints",
    "draft_suggestions",
    "research_watches",
    "document_originals",
    "audit",
    "workspaces",
  ];
  const databaseSnapshot = () =>
    restoredTables.map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
  const beforeDatabase = databaseSnapshot();
  db.exec(
    "CREATE TEMP TRIGGER reject_archive_save BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT, 'injected archive persistence failure'); END",
  );
  try {
    const failed = await sendArchive(owner, sourceArchiveBuffer);
    assert.equal(failed.status, 500);
    assert.deepEqual(databaseSnapshot(), beforeDatabase);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM document_comparisons WHERE id=?")
        .get(comparisonId).n,
      0,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM audit").get().n,
      beforeAudit,
    );
    assert.equal(
      db
        .prepare("SELECT value FROM workspaces WHERE id=?")
        .get(ownerRow.workspace_id).value,
      beforeRestore,
    );
  } finally {
    db.exec("DROP TRIGGER reject_archive_save");
  }
  // An exception after persistence must restore the same in-memory objects,
  // including collection identities, as well as rolling back SQLite writes.
  const state = JSON.parse(beforeRestore);
  const fullState = structuredClone(state);
  const stateCollections = { ...state };
  const localContext = {
    state,
    fullState,
    role: "owner",
    workspaceId: ownerRow.workspace_id,
    actor: ownerRow.id,
    audit() {},
  };
  const injected = createMatterArchive(db, () => localContext, {
    save() {
      db.prepare("UPDATE workspaces SET value=? WHERE id=?").run(
        JSON.stringify(state),
        ownerRow.workspace_id,
      );
      throw Error("injected after persistence");
    },
  });
  assert.throws(
    () => injected.restore(sourceArchiveBuffer),
    /injected after persistence/,
  );
  assert.equal(localContext.state, state);
  assert.equal(localContext.fullState, fullState);
  assert.deepEqual(fullState, JSON.parse(beforeRestore));
  assert.deepEqual(databaseSnapshot(), beforeDatabase);
  assert.deepEqual(state, JSON.parse(beforeRestore));
  for (const [key, value] of Object.entries(stateCollections))
    assert.equal(state[key], value);
  assert.equal(
    db
      .prepare("SELECT value FROM workspaces WHERE id=?")
      .get(ownerRow.workspace_id).value,
    beforeRestore,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM document_comparisons WHERE id=?")
      .get(comparisonId).n,
    0,
  );
  const restored = await sendArchive(owner, sourceArchiveBuffer);
  assert.equal(restored.status, 200);
  assert.equal(restored.data.matter.id, matterId);
  assert.equal(restored.data.matter.name, "Archive restore source");
  assert.equal(restored.data.mode, "full");
  assert.equal(restored.data.counts.documents, 2);
  assert.equal(restored.data.counts.drafts, 1);
  assert.equal(restored.data.counts.messages, 1);
  assert.equal(restored.data.counts.reviews, 1);
  assert.equal(restored.data.counts.tasks, 1);
  assert.equal(restored.data.counts.skills, 1);
  assert.equal(restored.data.counts.comparisons, 1);
  assert.equal(restored.data.counts.researchWatches, 1);
  assert.equal(restored.data.counts.workflowRuns, 1);
  assert.equal(restored.data.counts.workflowSchedules, 1);
  assert.equal(restored.data.counts.workflowTemplates, 1);
  assert.equal(restored.data.counts.legalOperations, 1);
  assert.equal(restored.data.counts.portalPublications, 1);
  assert.equal(restored.data.counts.jobs, 2);
  assert.equal(restored.data.counts.jobsRestoredAsFailed, 1);
  assert.equal(restored.data.counts.draftComments, 1);
  assert.equal(restored.data.counts.draftCheckpoints, 1);
  assert.equal(restored.data.counts.draftSuggestions, 1);
  assert.equal(restored.data.counts.originals, 1);
  assert.ok(
    restored.data.warnings.some((warning) =>
      /queued or running job record\(s\) were restored as failed/.test(warning),
    ),
  );
  assert.ok(
    restored.data.warnings.some((warning) =>
      /research watch\(es\) were restored disabled/.test(warning),
    ),
  );
  assert.ok(
    restored.data.warnings.some((warning) =>
      /workflow schedule\(s\) were restored disabled/.test(warning),
    ),
  );
  assert.ok(
    restored.data.warnings.some((warning) =>
      /not restored; audit history stays with the source/.test(warning),
    ),
  );
  const search = await owner.req("chat", {
    matterId,
    query: "governing law",
  });
  assert.equal(search.status, 200);
  assert.ok(search.data.citations.length > 0);
  assert.equal(search.data.citations[0].documentId, documentId);
  const restoredState = (await owner.req("state")).data;
  const restoredMatter = restoredState.matters.find(
    (matter) => matter.id === matterId,
  );
  assert.ok(restoredMatter);
  assert.equal(restoredMatter.name, "Archive restore source");
  const restoredDocument = restoredState.documents.find(
    (document) => document.id === documentId,
  );
  assert.equal(restoredDocument.text, sourceText);
  assert.deepEqual(restoredDocument.original, {
    sha256: digest(sourceBytes),
    size: sourceBytes.length,
  });
  const restoredReview = restoredState.reviews.find(
    (review) => review.id === reviewId,
  );
  assert.equal(restoredReview.cells[0].documentId, documentId);

  const restoredOriginal = db
    .prepare(
      "SELECT * FROM document_originals WHERE workspace_id=? AND document_id=?",
    )
    .get(ownerRow.workspace_id, documentId);
  assert.deepEqual(Buffer.from(restoredOriginal.bytes), sourceBytes);
  assert.equal(
    db.prepare("SELECT status FROM jobs WHERE id=?").get(queuedJobId).status,
    "failed",
  );
  assert.match(
    db.prepare("SELECT error FROM jobs WHERE id=?").get(queuedJobId).error,
    /was not executed here/,
  );
  assert.equal(
    db.prepare("SELECT status FROM jobs WHERE id=?").get(doneJobId).status,
    "completed",
  );
  assert.equal(
    db.prepare("SELECT status FROM workflow_runs WHERE id=?").get(runId).status,
    "completed",
  );
  assert.equal(
    db
      .prepare("SELECT enabled FROM workflow_schedules WHERE id=?")
      .get(scheduleId).enabled,
    0,
  );
  assert.equal(
    db.prepare("SELECT enabled FROM research_watches WHERE id=?").get(watchId)
      .enabled,
    0,
  );
  assert.equal(
    db
      .prepare("SELECT revoked FROM portal_publications WHERE id=?")
      .get(publicationId).revoked,
    0,
  );
  assert.ok(
    db.prepare("SELECT 1 FROM draft_suggestions WHERE id=?").get(suggestionId),
  );
  assert.ok(
    db
      .prepare("SELECT 1 FROM document_comparisons WHERE id=?")
      .get(comparisonId),
  );
  // Restored jobs never resume: the worker only picks queued work.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(
    db.prepare("SELECT status FROM jobs WHERE id=?").get(doneJobId).status,
    "completed",
  );

  // Collision policy: restoring the same archive again fails closed, then
  // restores under fresh identifiers with newIds.
  const collided = await sendArchive(owner, sourceArchiveBuffer);
  assert.equal(collided.status, 409);
  assert.match(collided.data.error, /newIds/);
  assert.match(collided.data.error, /matter records/);
  const remapped = await sendArchive(owner, sourceArchiveBuffer, "1");
  assert.equal(remapped.status, 200);
  assert.ok(remapped.data.matter.id !== matterId);
  assert.equal(remapped.data.counts.documents, 2);
  assert.ok(
    remapped.data.warnings.some((warning) =>
      /collided with existing records/.test(warning),
    ),
  );
  const remappedState = (await owner.req("state")).data,
    remappedMatter = remappedState.matters.find(
      (matter) => matter.id === remapped.data.matter.id,
    );
  assert.ok(remappedMatter);
  const comparisonCopy = JSON.parse(
    db
      .prepare("SELECT data FROM document_comparisons WHERE matter_id=?")
      .get(remapped.data.matter.id).data,
  );
  assert.notEqual(comparisonCopy.documentIds[0], documentId);
  assert.ok(
    remappedState.documents.some(
      (document) =>
        document.id === comparisonCopy.documentIds[0] &&
        document.matterId === remapped.data.matter.id,
    ),
  );
  assert.equal(
    remappedState.documents.filter(
      (document) => document.matterId === remapped.data.matter.id,
    ).length,
    2,
  );
  assert.ok(
    remappedState.reviews.find(
      (review) => review.matterId === remapped.data.matter.id,
    ).cells[0].documentId !== documentId,
  );
  const disabledSchedules = db
    .prepare(
      "SELECT COUNT(*) AS n FROM workflow_schedules WHERE workspace_id=? AND enabled=0",
    )
    .get(ownerRow.workspace_id).n;
  assert.ok(disabledSchedules >= 2);
  // The remapped copy stays internally consistent: run → template → skill.
  const remappedRun = db
    .prepare("SELECT * FROM workflow_runs WHERE matter_id=?")
    .get(remapped.data.matter.id);
  assert.ok(remappedRun);
  assert.notEqual(remappedRun.id, runId);
  assert.notEqual(remappedRun.template_id, templateId);
  const remappedTemplate = db
    .prepare("SELECT * FROM workflow_templates WHERE id=?")
    .get(remappedRun.template_id);
  assert.ok(remappedTemplate);
  assert.equal(remappedTemplate.workspace_id, ownerRow.workspace_id);
  const fixtureSkills = remappedState.skills.filter(
      (skill) => skill.name === "Fixture skill",
    ),
    remappedSkill = fixtureSkills.find((skill) => skill.id !== skillId);
  assert.equal(fixtureSkills.length, 2);
  assert.ok(remappedSkill);
  assert.equal(
    JSON.parse(remappedTemplate.definition).steps[0].skillId,
    remappedSkill.id,
  );
  assert.deepEqual(
    JSON.parse(remappedRun.data).steps.map((step) => step.skillId),
    [remappedSkill.id],
  );

  // Tampered and cross-matter archives are rejected.
  const entries = readZip(sourceArchiveBuffer);
  function rewrite(mutate) {
    const list = entries.map((entry) => ({
      path: entry.name,
      data: Buffer.from(entry.data),
    }));
    mutate(list);
    const manifestIndex = list.findIndex(
        (item) => item.path === "manifest.json",
      ),
      manifest = JSON.parse(list[manifestIndex].data.toString("utf8"));
    for (const item of list) {
      if (item.path === "manifest.json" || item.path === "SHA256SUMS") continue;
      const listed = manifest.files.find((file) => file.path === item.path);
      if (!listed) continue;
      listed.bytes = item.data.length;
      listed.sha256 = digest(item.data);
    }
    const listedSum = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    manifest.counts.listedBytes = listedSum;
    manifest.counts.archiveFiles = manifest.counts.listedFiles + 2;
    list[manifestIndex].data = Buffer.from(
      JSON.stringify(manifest, null, 2) + "\n",
    );
    const sumsIndex = list.findIndex((item) => item.path === "SHA256SUMS"),
      checksumText =
        list
          .filter((item) => item.path !== "SHA256SUMS")
          .map((item) => `${digest(item.data)}  ${item.path}`)
          .sort()
          .join("\n") + "\n";
    list[sumsIndex].data = Buffer.from(checksumText, "utf8");
    return buildZip(list, {});
  }
  assert.equal(verifyArchive(rewrite(() => {})).ok, true);
  assert.equal(
    (
      await sendArchive(
        owner,
        rewrite(() => {}),
      )
    ).status,
    409,
  );
  const crossMatter = rewrite((list) => {
    const index = list.findIndex(
        (item) => item.path === "matter/documents.json",
      ),
      content = JSON.parse(list[index].data.toString("utf8"));
    content[0].matterId = "00000000-0000-4000-8000-00000000c999";
    list[index].data = Buffer.from(JSON.stringify(content, null, 2) + "\n");
  });
  verifyArchive(crossMatter);
  const crossResult = await sendArchive(owner, crossMatter);
  assert.equal(crossResult.status, 400);
  assert.match(
    crossResult.data.error,
    /does not belong to the archived matter/,
  );
});
