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
