const { createHash, randomUUID } = require("node:crypto");
const multer = require("multer");
const { context } = require("./security");
const { buildZip, safeArchivePath } = require("./zip");
const { inspectArchive } = require("./matter-archive-verify");

const FORMAT = "counsel-matter-archive";
const VERSION = 1;
const MAX_METADATA_BYTES = 128 * 1024 * 1024;
const MAX_ORIGINAL_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 4_000;
const MAX_AUDIT_ROWS = 10_000;
// Aligned with the export ceiling: a full archive can carry up to 128 MiB of
// metadata plus 128 MiB of retained originals.
const RESTORE_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
// Restore intake limits mirror the application's own record limits so a
// restored matter behaves like the workspace it was exported from.
const WORKSPACE_DOCUMENT_LIMIT = 1000;
const RESTORE_LIMITS = {
  matterName: 200,
  client: 200,
  description: 2000,
  draftTitle: 500,
  taskTitle: 500,
  skillName: 200,
  skillCategory: 100,
  skillInstructions: 20000,
  documentTextCharacters: 2_000_000,
  reviewColumns: 12,
};

const fail = (status, message) => Object.assign(Error(message), { status });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const mib = (bytes) => `${Math.round(bytes / (1024 * 1024))} MiB`;
const pathKey = (value) => value.normalize("NFC").toLowerCase();

function safeName(value, fallback = "file", limit = 96) {
  const cleaned = String(value ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+/, "")
    .replace(/[. ]+$/, "")
    .trim();
  let shortened = "";
  for (const character of Array.from(cleaned).slice(0, limit)) {
    if (Buffer.byteLength(shortened + character, "utf8") > 180) break;
    shortened += character;
  }
  return shortened.trim() || fallback;
}

function fileStem(value, fallback) {
  const name = safeName(value, fallback);
  return (
    name.replace(/\.[A-Za-z0-9]{1,10}$/, "").replace(/[. ]+$/, "") || fallback
  );
}

function timestampSlug(value) {
  return new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function parse(value) {
  return JSON.parse(value);
}

function createMatterArchive(
  db,
  getContext = () => context.getStore(),
  options = {},
) {
  const persist = typeof options.save === "function" ? options.save : null;
  const limits = {
    metadataBytes: options.maxMetadataBytes ?? MAX_METADATA_BYTES,
    originalBytes: options.maxOriginalBytes ?? MAX_ORIGINAL_BYTES,
    entries: options.maxEntries ?? MAX_ENTRIES,
    auditRows: options.maxAuditRows ?? MAX_AUDIT_ROWS,
  };
  const hasTable = (() => {
    const cache = new Map();
    return (name) => {
      if (!cache.has(name))
        cache.set(
          name,
          !!db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(name),
        );
      return cache.get(name);
    };
  })();
  function rows(sql, params = []) {
    try {
      return db.prepare(sql).all(...params);
    } catch (error) {
      if (/no such table/i.test(error.message)) return [];
      throw error;
    }
  }
  function access(matterId) {
    const c = getContext();
    if (!c) throw fail(500, "Workspace context is unavailable.");
    if (!["owner", "editor"].includes(c.role))
      throw fail(403, "Owner or editor access is required to export a matter.");
    const matter = c.state.matters.find((item) => item.id === matterId);
    if (!matter) throw fail(404, "Matter not found.");
    return { c, matter };
  }
  function draftRows(workspaceId, drafts, table, columns) {
    if (!hasTable(table) || !drafts.length) return [];
    const found = [];
    for (const draft of drafts)
      found.push(
        ...rows(
          `SELECT ${columns} FROM ${table} WHERE workspace_id=? AND draft_id=? ORDER BY rowid`,
          [workspaceId, draft.id],
        ),
      );
    return found;
  }
  function plan(matterId, settings = {}) {
    const { c, matter } = access(matterId),
      includeOriginals = settings.originals === true,
      generatedAt = new Date(settings.now ?? Date.now()).toISOString(),
      identity = settings.identity || {
        userId: c.actor,
        email: "",
        role: c.role,
      },
      warnings = [];
    if (Number.isNaN(Date.parse(generatedAt)))
      throw fail(400, "Archive timestamp is invalid.");
    const documents = c.state.documents.filter(
        (item) => item.matterId === matterId,
      ),
      messages = c.state.messages.filter((item) => item.matterId === matterId),
      reviews = c.state.reviews.filter((item) => item.matterId === matterId),
      drafts = c.state.drafts.filter((item) => item.matterId === matterId),
      tasks = c.state.tasks.filter((item) => item.matterId === matterId);
    const payload = [],
      payloadNames = new Set();
    let payloadBytes = 0,
      metadataPayloadBytes = 0;
    function addEntry(name, data, kind, entryOptions = {}) {
      const entryPath = safeArchivePath(name),
        key = pathKey(entryPath),
        bytes = Buffer.isBuffer(data)
          ? data
          : data instanceof Uint8Array
            ? Buffer.from(data)
            : Buffer.from(String(data ?? ""), "utf8");
      if (payloadNames.has(key))
        throw fail(500, "Archive contains a duplicate path.");
      payloadNames.add(key);
      payloadBytes += bytes.length;
      if (payload.length >= limits.entries - 3)
        throw fail(413, "The matter has too many records for one archive.");
      if (kind !== "original") {
        metadataPayloadBytes += bytes.length;
        if (metadataPayloadBytes > limits.metadataBytes)
          throw fail(
            413,
            `The archive exceeds the ${mib(limits.metadataBytes)} metadata limit. Reduce the matter contents or export individual records.`,
          );
      }
      payload.push({
        path: entryPath,
        data: bytes,
        kind,
        store: entryOptions.store === true,
      });
      return bytes;
    }
    const documentMeta = documents.map((document, index) => {
      const { text, richContent, ...metadata } = document,
        source = Buffer.from(String(text || ""), "utf8"),
        textPath = `documents/${String(index + 1).padStart(4, "0")}-${fileStem(document.name, "document")}.txt`;
      addEntry(textPath, source, "document-text");
      return {
        ...metadata,
        archive: {
          textPath,
          bytes: source.length,
          sha256: sha256(source),
        },
      };
    });
    addEntry("matter/documents.json", json(documentMeta), "metadata");
    addEntry("matter/messages.json", json(messages), "metadata");
    addEntry("matter/reviews.json", json(reviews), "metadata");
    addEntry("matter/tasks.json", json(tasks), "metadata");
    addEntry("matter/matter.json", json(matter), "metadata");
    const draftMeta = drafts.map((draft, index) => {
      const { content, richContent, ...metadata } = draft,
        text = Buffer.from(String(content || ""), "utf8"),
        contentPath = `drafts/${String(index + 1).padStart(4, "0")}-${fileStem(draft.title, "draft")}.txt`;
      addEntry(contentPath, text, "draft-text");
      return {
        ...metadata,
        archive: {
          textPath: contentPath,
          bytes: text.length,
          sha256: sha256(text),
        },
      };
    });
    addEntry("matter/drafts.json", json(draftMeta), "metadata");
    if (drafts.length)
      warnings.push(
        "Current draft bodies are exported as plain text. Yjs collaboration history is excluded; checkpoint and suggestion records retain their stored structured data.",
      );

    const comparisonRows = rows(
      "SELECT id,data,created FROM document_comparisons WHERE workspace_id=? AND matter_id=? ORDER BY created,id",
      [c.workspaceId, matterId],
    );
    const comparisons = comparisonRows.map((row) => ({
      id: row.id,
      created: row.created,
      report: parse(row.data),
    }));
    addEntry("matter/comparisons.json", json(comparisons), "metadata");

    const watchRows = rows(
      "SELECT id,actor,data,next_scan,enabled FROM research_watches WHERE workspace_id=? AND matter_id=? ORDER BY rowid",
      [c.workspaceId, matterId],
    );
    const watches = watchRows.map((row) => ({
      id: row.id,
      actorId: row.actor,
      enabled: !!row.enabled,
      nextScan: row.next_scan,
      watch: parse(row.data),
    }));
    addEntry("matter/research-watches.json", json(watches), "metadata");

    const runRows = rows(
      "SELECT id,actor,template_id,data,status,created FROM workflow_runs WHERE workspace_id=? AND matter_id=? ORDER BY created,id",
      [c.workspaceId, matterId],
    );
    const runs = runRows.map((row) => ({
      id: row.id,
      actorId: row.actor,
      templateId: row.template_id,
      storedStatus: row.status,
      created: row.created,
      run: parse(row.data),
    }));
    addEntry("matter/workflow-runs.json", json(runs), "metadata");

    const scheduleRows = rows(
      "SELECT * FROM workflow_schedules WHERE workspace_id=? AND matter_id=? ORDER BY created,id",
      [c.workspaceId, matterId],
    );
    const schedules = scheduleRows.map((row) => ({
      id: row.id,
      actorId: row.actor,
      templateId: row.template_id,
      input: parse(row.input),
      intervalMinutes: row.interval_minutes,
      nextAt: row.next_at,
      enabled: !!row.enabled,
      lastRunId: row.last_run_id,
      lastError: row.last_error,
      created: row.created,
    }));
    addEntry("matter/workflow-schedules.json", json(schedules), "metadata");

    const templateIds = [
      ...new Set(
        [...runs, ...schedules].map((item) => item.templateId).filter(Boolean),
      ),
    ];
    const templates = [];
    for (let index = 0; index < templateIds.length; index += 150) {
      const chunk = templateIds.slice(index, index + 150);
      templates.push(
        ...rows(
          `SELECT id,definition,version,updated FROM workflow_templates WHERE workspace_id=? AND id IN (${chunk.map(() => "?").join(",")}) ORDER BY updated,id`,
          [c.workspaceId, ...chunk],
        ).map((row) => ({
          id: row.id,
          version: row.version,
          updated: row.updated,
          definition: parse(row.definition),
        })),
      );
    }
    addEntry("matter/workflow-templates.json", json(templates), "metadata");

    const skillIds = new Set();
    for (const template of templates)
      for (const step of template.definition?.steps || [])
        if (step.skillId) skillIds.add(step.skillId);
    for (const run of runs)
      for (const step of run.run?.steps || [])
        if (step.skillId) skillIds.add(step.skillId);
    const skills = (c.state.skills || [])
        .filter((skill) => skillIds.has(skill.id))
        .map((skill) => ({
          id: skill.id,
          name: skill.name,
          category: skill.category || "Custom",
          version: skill.version || 1,
          instructions: skill.instructions || "",
        })),
      missingSkillIds = [...skillIds].filter(
        (skillId) => !skills.some((skill) => skill.id === skillId),
      );
    addEntry("matter/skills.json", json(skills), "metadata");
    if (missingSkillIds.length)
      warnings.push(
        `${missingSkillIds.length} workflow skill reference(s) no longer resolve to a workspace skill; run records may retain frozen instructions.`,
      );
    const currentTemplates = new Map(
        templates.map((template) => [template.id, template]),
      ),
      missingTemplateIds = new Set();
    let staleTemplateRuns = 0;
    for (const run of runs) {
      const template = currentTemplates.get(run.templateId);
      if (!template) missingTemplateIds.add(run.templateId);
      else if (
        run.run?.templateVersion &&
        run.run.templateVersion !== template.version
      )
        staleTemplateRuns++;
    }
    if (missingTemplateIds.size)
      warnings.push(
        `${missingTemplateIds.size} workflow template(s) referenced by runs are no longer available; run records retain their step snapshots.`,
      );
    if (staleTemplateRuns)
      warnings.push(
        `${staleTemplateRuns} workflow run(s) used an older template version; current template definitions are included.`,
      );

    const operationRows = rows(
      "SELECT id,kind,data FROM legal_operations WHERE workspace_id=? AND matter_id=? ORDER BY rowid",
      [c.workspaceId, matterId],
    );
    const operations = operationRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      record: parse(row.data),
    }));
    addEntry("matter/legal-operations.json", json(operations), "metadata");

    const portalRows = rows(
      "SELECT * FROM portal_publications WHERE workspace_id=? AND matter_id=? ORDER BY created,id",
      [c.workspaceId, matterId],
    );
    const publications = portalRows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      documentId: row.document_id,
      sourceHash: row.source_hash,
      content: row.content,
      recipients: parse(row.recipients),
      created: row.created,
      publisher: row.publisher,
      revoked: !!row.revoked,
    }));
    addEntry("matter/portal-publications.json", json(publications), "metadata");

    const jobRows = rows(
      "SELECT * FROM jobs WHERE workspace_id=? AND matter_id=? ORDER BY created,id",
      [c.workspaceId, matterId],
    );
    const jobs = jobRows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      payload: parse(row.payload),
      status: row.status,
      result: row.result ? parse(row.result) : null,
      error: row.error,
      created: row.created,
      updated: row.updated,
    }));
    addEntry("matter/jobs.json", json(jobs), "metadata");

    const comments = draftRows(
      c.workspaceId,
      drafts,
      "draft_comments",
      "id,draft_id,author,body,resolved,created",
    );
    addEntry(
      "matter/draft-comments.json",
      json(
        comments.map((row) => ({
          id: row.id,
          draftId: row.draft_id,
          author: row.author,
          body: row.body,
          resolved: !!row.resolved,
          created: row.created,
        })),
      ),
      "metadata",
    );
    const checkpoints = draftRows(
      c.workspaceId,
      drafts,
      "draft_checkpoints",
      "id,draft_id,author,name,content,created",
    );
    addEntry(
      "matter/draft-checkpoints.json",
      json(
        checkpoints.map((row) => ({
          id: row.id,
          draftId: row.draft_id,
          author: row.author,
          name: row.name,
          content: row.content,
          created: row.created,
        })),
      ),
      "metadata",
    );
    const suggestions = draftRows(
      c.workspaceId,
      drafts,
      "draft_suggestions",
      "id,draft_id,data",
    ).map((row) => ({
      id: row.id,
      draftId: row.draft_id,
      suggestion: parse(row.data),
    }));
    addEntry("matter/draft-suggestions.json", json(suggestions), "metadata");

    const documentIds = new Set(documents.map((document) => document.id)),
      retainedRows = hasTable("document_originals")
        ? rows(
            "SELECT document_id,name,mime,sha256,length(bytes) AS bytes FROM document_originals WHERE workspace_id=? AND matter_id=? ORDER BY rowid",
            [c.workspaceId, matterId],
          )
        : [],
      orphanedOriginals = retainedRows.filter(
        (row) => !documentIds.has(row.document_id),
      ),
      originalRows = retainedRows.filter((row) =>
        documentIds.has(row.document_id),
      );
    if (orphanedOriginals.length)
      warnings.push(
        `${orphanedOriginals.length} retained original file(s) no longer referenced by a current document were omitted.`,
      );
    const originalIds = new Set(originalRows.map((row) => row.document_id));
    let originalBytes = 0;
    for (const row of originalRows) {
      if (!Number.isSafeInteger(row.bytes) || row.bytes < 0)
        throw fail(409, "A retained original has invalid size metadata.");
      originalBytes += row.bytes;
    }
    const originalRecords = originalRows.map((row, index) => ({
      documentId: row.document_id,
      name: row.name,
      mime: row.mime,
      sha256: row.sha256,
      bytes: row.bytes,
      path: `originals/${String(index + 1).padStart(4, "0")}-${safeName(row.name, "original")}`,
    }));
    if (includeOriginals) {
      if (!originalRecords.length)
        throw fail(
          400,
          "No retained original files are available for this matter. Export metadata instead.",
        );
      if (originalBytes > limits.originalBytes)
        throw fail(
          413,
          `The requested originals exceed the ${mib(limits.originalBytes)} archive limit. Export metadata only or retain smaller source files.`,
        );
      if (payload.length + originalRecords.length + 4 > limits.entries)
        throw fail(413, "The matter has too many records for one archive.");
    }
    addEntry(
      "matter/originals.json",
      json({
        included: includeOriginals,
        retained: originalRecords.map((row) => ({
          ...row,
          path: includeOriginals ? row.path : null,
        })),
        unavailableDocumentIds: documents
          .filter((document) => !originalIds.has(document.id))
          .map((document) => document.id),
        note: includeOriginals
          ? "Each retained original is included at the listed path and its SHA-256 is recorded here and in the manifest."
          : "Original files were not included. Re-export with originals enabled to retain the exact source files.",
      }),
      "metadata",
    );
    if (includeOriginals)
      for (const original of originalRecords) {
        const row = db
          .prepare(
            "SELECT bytes FROM document_originals WHERE workspace_id=? AND document_id=? AND matter_id=?",
          )
          .get(c.workspaceId, original.documentId, matterId);
        if (!row) throw fail(409, "A retained original disappeared.");
        const bytes = Buffer.from(row.bytes);
        if (
          bytes.length !== original.bytes ||
          sha256(bytes) !== original.sha256
        )
          throw fail(
            409,
            "A retained original failed its integrity check. The archive was not created.",
          );
        addEntry(original.path, bytes, "original", { store: true });
      }
    if (documents.length > originalIds.size)
      warnings.push(
        `${documents.length - originalIds.size} document(s) have no retained original file.`,
      );
    if (!includeOriginals && originalRecords.length)
      warnings.push(
        `${originalRecords.length} retained original file(s) are not included in metadata-only mode.`,
      );

    let audit = {
      available: false,
      rows: [],
      note: "Audit records are owner-only. Ask a workspace owner to export an audited archive.",
    };
    if (c.role === "owner") {
      const resourceIds = [
          matterId,
          ...documents.map((item) => item.id),
          ...messages.map((item) => item.id),
          ...reviews.map((item) => item.id),
          ...drafts.map((item) => item.id),
          ...tasks.map((item) => item.id),
          ...comparisons.map((item) => item.id),
          ...watches.map((item) => item.id),
          ...runs.map((item) => item.id),
          ...schedules.map((item) => item.id),
          ...templates.map((item) => item.id),
          ...skills.map((item) => item.id),
          ...operations.map((item) => item.id),
          ...publications.map((item) => item.id),
          ...jobs.map((item) => item.id),
          ...comments.map((item) => item.id),
          ...checkpoints.map((item) => item.id),
          ...suggestions.map((item) => item.id),
        ],
        uniqueResources = [...new Set(resourceIds)],
        auditRows = rows(
          `SELECT id,actor,action,resource,created FROM audit
           WHERE workspace_id=? AND resource IN (SELECT value FROM json_each(?))
           ORDER BY created,id LIMIT ?`,
          [
            c.workspaceId,
            JSON.stringify(uniqueResources),
            limits.auditRows + 1,
          ],
        ),
        auditTruncated = auditRows.length > limits.auditRows;
      if (auditTruncated) auditRows.length = limits.auditRows;
      audit = {
        available: true,
        rows: auditRows.map((row) => ({
          id: row.id,
          actorId: row.actor,
          action: row.action,
          resource: row.resource,
          created: row.created,
        })),
        bestEffort: true,
        note: "Audit rows are matched by resource ID. Events without a matter-attributable resource are omitted.",
      };
      if (auditTruncated)
        warnings.push(
          `Audit export was capped at ${limits.auditRows} ${limits.auditRows === 1 ? "row" : "rows"}; the complete audit table remains in the workspace.`,
        );
    }
    addEntry("matter/audit.json", json(audit), "metadata");
    warnings.push(
      "Checksums detect changes to this archive; they do not prove who created or approved it. Verify provenance separately.",
    );

    const counts = {
      documents: documents.length,
      currentDocuments: documents.filter((item) => !item.supersededBy).length,
      versions: documents.filter((item) => !!item.supersededBy).length,
      messages: messages.length,
      reviews: reviews.length,
      drafts: drafts.length,
      tasks: tasks.length,
      comparisons: comparisons.length,
      researchWatches: watches.length,
      workflowRuns: runs.length,
      workflowSchedules: schedules.length,
      workflowTemplates: templates.length,
      skills: skills.length,
      skillsMissing: missingSkillIds.length,
      legalOperations: operations.length,
      portalPublications: publications.length,
      jobs: jobs.length,
      draftComments: comments.length,
      draftCheckpoints: checkpoints.length,
      draftSuggestions: suggestions.length,
      originalsRetained: originalRecords.length,
      originalsMissing: Math.max(0, documents.length - originalIds.size),
      originalBytes,
      auditRows: audit.rows.length,
      listedFiles: 0,
      listedBytes: 0,
      archiveFiles: 0,
    };
    const readme = [
      "Counsel matter archive",
      "======================",
      "",
      `Matter: ${matter.name}`,
      `Client: ${matter.client || "Not recorded"}`,
      `Matter ID: ${matter.id}`,
      `Generated: ${generatedAt}`,
      `Mode: ${includeOriginals ? "Full archive with retained originals" : "Metadata and source text"}`,
      `Exported by: ${identity.email || identity.userId || "Workspace member"} (${identity.role || c.role})`,
      "",
      "Contents",
      "--------",
      "README.txt             This file.",
      "manifest.json          Archive metadata; lists every payload file with its size and SHA-256.",
      "SHA256SUMS             Checksums for every file except this checksum file.",
      "matter/                Matter metadata and structured records.",
      "documents/             Readable source text, one file per document version.",
      "drafts/                Readable draft text.",
      "originals/             Exact retained source files, only in a full archive.",
      "",
      "Scope",
      "-----",
      "This is a portable export of this matter's records and source text, not a full workspace backup.",
      "Workspace users, model settings, connector credentials, notification channels and Yjs collaboration",
      "history are not included. Workflow runs retain their step snapshots; workflow templates are the",
      "current definitions. Restore is owner-only: POST this archive to /api/matters/archive/restore on a",
      "workspace (optionally with the newIds field, which restores the matter under fresh identifiers when",
      "identifiers collide). Restored jobs never run, schedules and research watches restore disabled, and",
      "audit rows stay with the source workspace. Draft bodies are exported and restored as plain text.",
      "",
      "Verification",
      "------------",
      "Extract the archive, then run one of the following from the extracted directory:",
      "  sha256sum -c SHA256SUMS",
      "  shasum -a 256 -c SHA256SUMS",
      "On Windows PowerShell, compare each hash with Get-FileHash -Algorithm SHA256.",
      "",
      "From a Counsel workspace checkout, verify the ZIP and manifest without extracting:",
      "  node scripts/verify-matter-archive.js <archive.zip>",
      "  npm run verify:archive -- <archive.zip>",
      "",
      "Limits and privacy",
      "------------------",
      "This archive can contain confidential client material, source text, internal identifiers",
      "and client-portal recipient addresses. Store and share it only under the matter's confidentiality",
      "rules. The archive is not encrypted. Check the destination before transferring it.",
      "",
      "Checksums detect accidental or deliberate changes made without updating SHA256SUMS. They are not",
      "a digital signature and do not establish who created the archive. The audit subset is owner-only,",
      "best-effort and may omit events that are not attributable to a matter resource. This export is a",
      "record of the workspace, not legal advice or a representation that the underlying matter is complete.",
      "",
    ].join("\n");
    const readmeEntry = {
      path: "README.txt",
      data: Buffer.from(readme, "utf8"),
      kind: "readme",
      store: false,
    };
    counts.listedFiles = 1 + payload.length;
    counts.listedBytes = readmeEntry.data.length + payloadBytes;
    counts.archiveFiles = counts.listedFiles + 2;
    const manifest = {
      format: FORMAT,
      version: VERSION,
      generatedAt,
      exportedBy: {
        userId: identity.userId || c.actor,
        email: identity.email || "",
        role: identity.role || c.role,
      },
      workspaceId: c.workspaceId,
      matter: {
        id: matter.id,
        name: matter.name,
        client: matter.client || "",
      },
      mode: includeOriginals ? "full" : "metadata",
      originalsIncluded: includeOriginals,
      counts,
      warnings,
      files: [readmeEntry, ...payload].map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        bytes: entry.data.length,
        sha256: sha256(entry.data),
      })),
    };
    const manifestEntry = {
        path: "manifest.json",
        data: Buffer.from(json(manifest), "utf8"),
        kind: "manifest",
        store: false,
      },
      checksumEntries = [readmeEntry, ...payload, manifestEntry]
        .map((entry) => ({
          path: entry.path,
          hash: sha256(entry.data),
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      checksumText =
        checksumEntries
          .map((entry) => `${entry.hash}  ${entry.path}`)
          .join("\n") + "\n",
      checksumEntry = {
        path: "SHA256SUMS",
        data: Buffer.from(checksumText, "utf8"),
        kind: "checksums",
        store: false,
      },
      entries = [readmeEntry, ...payload, manifestEntry, checksumEntry];
    const metadataBytes = entries.reduce(
      (sum, entry) => sum + (entry.kind === "original" ? 0 : entry.data.length),
      0,
    );
    if (metadataBytes > limits.metadataBytes)
      throw fail(
        413,
        `The archive exceeds the ${mib(limits.metadataBytes)} metadata limit. Reduce the matter contents or export individual records.`,
      );
    if (entries.length > limits.entries)
      throw fail(413, "The matter has too many records for one archive.");
    return {
      c,
      matter,
      entries,
      manifest,
      generatedAt,
      includeOriginals,
      originalBytes,
      metadataBytes,
      counts,
      warnings,
      limits,
      audit,
    };
  }
  function summary(result) {
    const metadataFiles = result.entries.filter(
        (entry) => entry.kind !== "original",
      ).length,
      fullBytes = result.metadataBytes + result.counts.originalBytes;
    return {
      format: FORMAT,
      version: VERSION,
      generatedAt: result.generatedAt,
      matter: {
        id: result.matter.id,
        name: result.matter.name,
        client: result.matter.client || "",
      },
      metadata: {
        documents: result.counts.documents,
        currentDocuments: result.counts.currentDocuments,
        versions: result.counts.versions,
        messages: result.counts.messages,
        reviews: result.counts.reviews,
        drafts: result.counts.drafts,
        tasks: result.counts.tasks,
        comparisons: result.counts.comparisons,
        researchWatches: result.counts.researchWatches,
        workflowRuns: result.counts.workflowRuns,
        workflowSchedules: result.counts.workflowSchedules,
        workflowTemplates: result.counts.workflowTemplates,
        skills: result.counts.skills,
        skillsMissing: result.counts.skillsMissing,
        legalOperations: result.counts.legalOperations,
        portalPublications: result.counts.portalPublications,
        jobs: result.counts.jobs,
        draftComments: result.counts.draftComments,
        draftCheckpoints: result.counts.draftCheckpoints,
        draftSuggestions: result.counts.draftSuggestions,
        originalsRetained: result.counts.originalsRetained,
        originalsMissing: result.counts.originalsMissing,
        auditRows: result.counts.auditRows,
        audit: {
          available: result.audit.available,
          rows: result.counts.auditRows,
        },
        files: metadataFiles,
        bytes: result.metadataBytes,
      },
      full: {
        available: result.counts.originalsRetained > 0,
        files: metadataFiles + result.counts.originalsRetained,
        bytes: fullBytes,
        exceedsLimit:
          result.counts.originalBytes > limits.originalBytes ||
          metadataFiles + result.counts.originalsRetained > limits.entries,
      },
      limits: {
        metadataBytes: limits.metadataBytes,
        originalBytes: limits.originalBytes,
        entries: limits.entries,
        auditRows: limits.auditRows,
      },
      warnings: result.warnings,
    };
  }
  function preview(matterId, settings = {}) {
    return summary(plan(matterId, { ...settings, originals: false }));
  }
  function build(matterId, settings = {}) {
    const result = plan(matterId, settings),
      buffer = buildZip(result.entries, {
        date: new Date(result.generatedAt),
      }),
      digest = sha256(buffer),
      slug =
        matterName(result.matter.name)
          .replace(/[^A-Za-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "matter",
      filename = `counsel-${slug}-${timestampSlug(result.generatedAt)}-${result.includeOriginals ? "full" : "metadata"}.zip`;
    if (result.c.audit)
      result.c.audit(
        result.c.workspaceId,
        result.c.actor,
        "matter.archive.exported",
        matterId,
      );
    return {
      buffer,
      digest,
      filename,
      manifest: result.manifest,
      counts: result.counts,
      warnings: result.warnings,
    };
  }

  // ---------------------------------------------------------------
  // Restore
  // ---------------------------------------------------------------

  function plainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function requireText(value, label, limit) {
    if (typeof value !== "string" || !value.length)
      throw fail(400, `The archived ${label} is invalid.`);
    if (limit !== undefined && value.length > limit)
      throw fail(
        400,
        `The archived ${label} exceeds the ${limit}-character record limit.`,
      );
    return value;
  }

  function requireCreated(value, label) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
      throw fail(400, `The archived ${label} timestamp is invalid.`);
    return value;
  }

  function requireMatterRef(value, label, matterId) {
    if (value !== matterId)
      throw fail(
        400,
        `The archived ${label} does not belong to the archived matter. The archive is not restorable.`,
      );
    return value;
  }

  function requireMatchingDraft(value, label, draftIds) {
    if (!draftIds.has(value))
      throw fail(
        400,
        `The archived ${label} references a draft that is not part of the archive. The archive is not restorable.`,
      );
    return value;
  }

  function restore(buffer, settings = {}) {
    const c = getContext();
    if (!c) throw fail(500, "Workspace context is unavailable.");
    if (c.role !== "owner")
      throw fail(
        403,
        "Workspace owner access is required to restore a matter archive.",
      );
    if (!persist) throw fail(500, "Restore persistence is not configured.");
    if (!Buffer.isBuffer(buffer) || !buffer.length)
      throw fail(400, "Send the archive ZIP in the archive field.");
    let parsed;
    try {
      parsed = inspectArchive(buffer);
    } catch (error) {
      throw fail(400, `Archive verification failed: ${error.message}`);
    }
    const {
        files,
        manifest,
        matter,
        documentIds,
        draftIds,
        documents,
        drafts,
        skills,
        originals,
        audit,
        messages,
        reviews,
        tasks,
        comparisons,
        watches,
        runs,
        schedules,
        templates,
        operations,
        publications,
        jobs,
        comments,
        checkpoints,
        suggestions,
      } = parsed,
      matterId = requireText(matter.id, "matter identifier"),
      warnings = [],
      counts = {};

    // Structural validation. The verifier established integrity (sizes and
    // checksums); these calls establish that every record can be stored
    // safely on this instance and belongs to the archived matter only.
    requireCreated(matter.created, "matter");
    requireText(matter.name, "matter name", RESTORE_LIMITS.matterName);
    if (matter.client !== undefined)
      requireText(matter.client || "", "matter client", RESTORE_LIMITS.client);
    if (matter.description !== undefined)
      requireText(
        matter.description || "",
        "matter description",
        RESTORE_LIMITS.description,
      );
    for (const document of documents) {
      requireMatterRef(document.matterId, "document", matterId);
      requireText(document.name, "document name");
      requireCreated(document.created, "document");
      const source = files.get(document.archive.textPath).data.toString("utf8");
      if (source.length > RESTORE_LIMITS.documentTextCharacters)
        throw fail(
          400,
          `An archived document exceeds the ${RESTORE_LIMITS.documentTextCharacters}-character record limit.`,
        );
    }
    for (const message of messages) {
      requireMatterRef(message.matterId, "message", matterId);
      requireText(message.query, "message query");
      requireCreated(message.created, "message");
    }
    for (const review of reviews) {
      requireMatterRef(review.matterId, "review", matterId);
      requireText(review.name, "review name");
      requireCreated(review.created, "review");
      if (
        !Array.isArray(review.columns) ||
        review.columns.length < 1 ||
        review.columns.length > RESTORE_LIMITS.reviewColumns ||
        review.columns.some((column) => typeof column !== "string")
      )
        throw fail(400, "The archived review columns are invalid.");
      for (const cell of review.cells || [])
        if (!documentIds.has(cell?.documentId))
          throw fail(
            400,
            "An archived review cell references a document that is not part of the archive. The archive is not restorable.",
          );
    }
    for (const draft of drafts) {
      requireMatterRef(draft.matterId, "draft", matterId);
      requireText(draft.title, "draft title", RESTORE_LIMITS.draftTitle);
      requireCreated(draft.created, "draft");
    }
    for (const task of tasks) {
      requireMatterRef(task.matterId, "task", matterId);
      requireText(task.title, "task title", RESTORE_LIMITS.taskTitle);
    }
    for (const skill of skills) {
      requireText(skill.name, "skill name", RESTORE_LIMITS.skillName);
      const category = skill.category || "Custom";
      if (
        typeof category !== "string" ||
        category.length > RESTORE_LIMITS.skillCategory
      )
        throw fail(400, "The archived skill category is invalid.");
      requireText(
        skill.instructions,
        "skill instructions",
        RESTORE_LIMITS.skillInstructions,
      );
    }
    for (const comparison of comparisons) {
      if (!plainObject(comparison.report))
        throw fail(400, "The archived comparison report is invalid.");
      requireCreated(comparison.created, "comparison");
    }
    for (const watch of watches) {
      if (
        !plainObject(watch.watch) ||
        !Number.isInteger(watch.nextScan) ||
        typeof watch.actorId !== "string" ||
        !watch.actorId
      )
        throw fail(400, "The archived research watch is invalid.");
    }
    for (const run of runs) {
      if (
        !plainObject(run.run) ||
        typeof run.storedStatus !== "string" ||
        typeof run.actorId !== "string" ||
        !run.actorId
      )
        throw fail(400, "The archived workflow run is invalid.");
    }
    for (const schedule of schedules) {
      if (
        !Number.isInteger(schedule.intervalMinutes) ||
        schedule.intervalMinutes < 1 ||
        !Number.isInteger(schedule.nextAt) ||
        typeof schedule.actorId !== "string" ||
        !schedule.actorId
      )
        throw fail(400, "The archived workflow schedule is invalid.");
    }
    for (const template of templates) {
      if (
        !plainObject(template.definition) ||
        !Number.isInteger(template.version) ||
        template.version < 1
      )
        throw fail(400, "The archived workflow template is invalid.");
      requireCreated(template.updated, "template");
    }
    for (const operation of operations) {
      if (typeof operation.kind !== "string" || !plainObject(operation.record))
        throw fail(400, "The archived legal operation is invalid.");
    }
    for (const publication of publications) {
      requireText(publication.title, "portal publication title");
      requireText(publication.content, "portal publication content");
      if (
        typeof publication.kind !== "string" ||
        typeof publication.publisher !== "string" ||
        !publication.publisher ||
        !Array.isArray(publication.recipients) ||
        typeof publication.revoked !== "boolean"
      )
        throw fail(400, "The archived portal publication is invalid.");
      requireCreated(publication.created, "portal publication");
    }
    for (const job of jobs) {
      if (
        typeof job.kind !== "string" ||
        typeof job.userId !== "string" ||
        !job.userId
      )
        throw fail(400, "The archived job record is invalid.");
      if (!["queued", "running", "completed", "failed"].includes(job.status))
        throw fail(400, "The archived job record is invalid.");
    }
    for (const comment of comments) {
      requireMatchingDraft(comment.draftId, "draft comment", draftIds);
      if (
        typeof comment.author !== "string" ||
        !comment.author ||
        typeof comment.body !== "string" ||
        !comment.body
      )
        throw fail(400, "The archived draft comment is invalid.");
    }
    for (const checkpoint of checkpoints) {
      requireMatchingDraft(checkpoint.draftId, "draft checkpoint", draftIds);
      if (
        typeof checkpoint.author !== "string" ||
        !checkpoint.author ||
        typeof checkpoint.name !== "string" ||
        !checkpoint.name ||
        typeof checkpoint.content !== "string"
      )
        throw fail(400, "The archived draft checkpoint is invalid.");
    }
    for (const suggestion of suggestions) {
      requireMatchingDraft(suggestion.draftId, "draft suggestion", draftIds);
      if (!plainObject(suggestion.suggestion))
        throw fail(400, "The archived draft suggestion is invalid.");
    }

    // Collision policy: any identifier already present on this instance is a
    // conflict. Without the newIds flag the restore fails closed; with it,
    // every archived identifier is remapped to a fresh one so nothing is ever
    // overwritten silently.
    const conflicts = [];
    function conflict(kind, count) {
      if (count) conflicts.push({ kind, count });
    }
    const tableIds = (table) =>
      hasTable(table)
        ? new Set(
            db
              .prepare(`SELECT id FROM ${table} WHERE id IS NOT NULL`)
              .all()
              .map((row) => row.id),
          )
        : new Set();
    const stateIds = (collection) =>
      new Set((c.fullState[collection] || []).map((item) => item.id));
    const existingSkills = new Set(
      (c.fullState.skills || []).map((skill) => skill.id),
    );
    const existingTables = {
      comparisons: tableIds("document_comparisons"),
      watches: tableIds("research_watches"),
      runs: tableIds("workflow_runs"),
      schedules: tableIds("workflow_schedules"),
      templates: tableIds("workflow_templates"),
      operations: tableIds("legal_operations"),
      publications: tableIds("portal_publications"),
      jobs: tableIds("jobs"),
      comments: tableIds("draft_comments"),
      checkpoints: tableIds("draft_checkpoints"),
      suggestions: tableIds("draft_suggestions"),
    };
    const existingState = {
      documents: stateIds("documents"),
      messages: stateIds("messages"),
      reviews: stateIds("reviews"),
      drafts: stateIds("drafts"),
      tasks: stateIds("tasks"),
    };
    if (c.fullState.matters.some((m) => m.id === matterId))
      conflict("matter records", 1);
    conflict(
      "documents",
      documents.filter((d) => existingState.documents.has(d.id)).length,
    );
    conflict(
      "messages",
      messages.filter((m) => existingState.messages.has(m.id)).length,
    );
    conflict(
      "reviews",
      reviews.filter((r) => existingState.reviews.has(r.id)).length,
    );
    conflict(
      "drafts",
      drafts.filter((d) => existingState.drafts.has(d.id)).length,
    );
    conflict(
      "tasks",
      tasks.filter((t) => existingState.tasks.has(t.id)).length,
    );
    conflict("skills", skills.filter((s) => existingSkills.has(s.id)).length);
    conflict(
      "comparisons",
      comparisons.filter((r) => existingTables.comparisons.has(r.id)).length,
    );
    conflict(
      "research watches",
      watches.filter((r) => existingTables.watches.has(r.id)).length,
    );
    conflict(
      "workflow runs",
      runs.filter((r) => existingTables.runs.has(r.id)).length,
    );
    conflict(
      "workflow schedules",
      schedules.filter((r) => existingTables.schedules.has(r.id)).length,
    );
    conflict(
      "workflow templates",
      templates.filter((r) => existingTables.templates.has(r.id)).length,
    );
    conflict(
      "legal operations",
      operations.filter((r) => existingTables.operations.has(r.id)).length,
    );
    conflict(
      "portal publications",
      publications.filter((r) => existingTables.publications.has(r.id)).length,
    );
    conflict("jobs", jobs.filter((r) => existingTables.jobs.has(r.id)).length);
    conflict(
      "draft comments",
      comments.filter((r) => existingTables.comments.has(r.id)).length,
    );
    conflict(
      "draft checkpoints",
      checkpoints.filter((r) => existingTables.checkpoints.has(r.id)).length,
    );
    conflict(
      "draft suggestions",
      suggestions.filter((r) => existingTables.suggestions.has(r.id)).length,
    );
    const remap = new Map();
    if (conflicts.length) {
      const summary = conflicts
          .map((entry) => `${entry.count} ${entry.kind}`)
          .join(", "),
        message =
          `Restore would overwrite existing workspace records: ${summary}. ` +
          "Re-submit the request with newIds=1 to restore the matter under fresh identifiers.";
      if (!settings.newIds) throw fail(409, message);
      warnings.push(
        `${conflicts.length} archived record type(s) collided with existing records: ${summary}. The matter was restored under fresh identifiers.`,
      );
      const collected = [];
      for (const record of [
        matter,
        ...documents,
        ...messages,
        ...reviews,
        ...drafts,
        ...tasks,
        ...skills,
        ...comparisons,
        ...watches,
        ...runs,
        ...schedules,
        ...templates,
        ...operations,
        ...publications,
        ...jobs,
        ...comments,
        ...checkpoints,
        ...suggestions,
      ])
        if (record?.id) collected.push(record.id);
      for (const id of new Set(collected)) remap.set(id, randomUUID());
    }
    function remapIds(value) {
      if (Array.isArray(value)) return value.map(remapIds);
      if (plainObject(value)) {
        const out = {};
        for (const [key, item] of Object.entries(value))
          if (key !== "archive") out[key] = remapIds(item);
        return out;
      }
      if (typeof value === "string") return remap.get(value) ?? value;
      return value;
    }
    const mapped = remapIds;
    const newMatterId = mapped(matterId);
    const sourceText = (item) =>
      files.get(item.archive.textPath).data.toString("utf8");

    // Side-effect policy. Restored records never resume execution on this
    // instance; every conversion is reported to the caller.
    const pendingJobs = jobs.filter(
      (job) => job.status === "queued" || job.status === "running",
    );
    if (pendingJobs.length)
      warnings.push(
        `${pendingJobs.length} queued or running job record(s) were restored as failed; execution state never carries over between instances.`,
      );
    const jobRecords = jobs.map((job) => {
      const converted = job.status === "queued" || job.status === "running";
      return {
        id: job.id,
        userId: job.userId,
        kind: job.kind,
        payload: JSON.stringify(mapped(job.payload)),
        status: converted ? "failed" : job.status,
        result:
          job.result === null || job.result === undefined
            ? null
            : JSON.stringify(job.result),
        error: converted
          ? "Restored from a matter archive; this job was queued on the source instance and was not executed here."
          : job.error,
        created: job.created,
        updated: job.updated,
      };
    });
    const terminal = ["completed", "cancelled", "failed"];
    const pausedRuns = runs.filter(
      (run) => !terminal.includes(run.storedStatus),
    );
    if (pausedRuns.length)
      warnings.push(
        `${pausedRuns.length} workflow run(s) without a final status were restored as cancelled.`,
      );
    const runRecords = runs.map((run) => ({
      id: run.id,
      actorId: run.actorId,
      templateId: run.templateId,
      data: JSON.stringify(mapped(run.run)),
      status: terminal.includes(run.storedStatus)
        ? run.storedStatus
        : "cancelled",
      created: run.created,
    }));
    if (schedules.length)
      warnings.push(
        `${schedules.length} workflow schedule(s) were restored disabled; enable each one after reviewing its interval.`,
      );
    const scheduleRecords = schedules.map((schedule) => ({
      id: schedule.id,
      actorId: schedule.actorId,
      templateId: schedule.templateId,
      input: JSON.stringify(mapped(schedule.input)),
      intervalMinutes: schedule.intervalMinutes,
      nextAt: schedule.nextAt,
      lastRunId: schedule.lastRunId ? mapped(schedule.lastRunId) : null,
      lastError: schedule.lastError,
      created: schedule.created,
    }));
    if (watches.length)
      warnings.push(
        `${watches.length} research watch(es) were restored disabled because watch scans perform live queries against public legal sources.`,
      );
    const watchRecords = watches.map((watch) => ({
      id: watch.id,
      actorId: watch.actorId,
      data: JSON.stringify(mapped(watch.watch)),
      nextScan: watch.nextScan,
    }));
    if (publications.length)
      warnings.push(
        `${publications.length} client portal publication(s) were restored as recorded, including revoked state; portal visibility follows those records on this instance.`,
      );
    if (documents.length || drafts.length)
      warnings.push(
        `Documents and drafts are restored as plain text from the archive${
          manifest.originalsIncluded
            ? `, together with ${originals.retained.length} re-attached original file(s)`
            : "; original source files are not part of a metadata-only archive, so restored documents keep their recorded original metadata without the file contents"
        }. Rich formatting and collaboration history are not part of the archive format.`,
      );
    if (audit.available)
      warnings.push(
        `${audit.rows.length} archived audit row(s) were not restored; audit history stays with the source workspace.`,
      );
    else
      warnings.push(
        "The archive does not include audit rows; the restored matter starts without audit history on this instance.",
      );
    if (
      (c.fullState.documents || []).length + documents.length >
      WORKSPACE_DOCUMENT_LIMIT
    )
      throw fail(
        409,
        `Restoring this archive would exceed the workspace document limit of ${WORKSPACE_DOCUMENT_LIMIT}. Remove documents or restore into a fresh workspace.`,
      );

    // Write everything. The workspace mutation queue serializes this request,
    // so the collision checks above cannot race other writers.
    for (const comparison of comparisons)
      db.prepare("INSERT INTO document_comparisons VALUES(?,?,?,?,?)").run(
        mapped(comparison.id),
        c.workspaceId,
        newMatterId,
        JSON.stringify(comparison.report),
        comparison.created,
      );
    for (const template of templates)
      db.prepare("INSERT INTO workflow_templates VALUES(?,?,?,?,?)").run(
        mapped(template.id),
        c.workspaceId,
        JSON.stringify(mapped(template.definition)),
        template.version,
        template.updated,
      );
    for (const run of runRecords)
      db.prepare("INSERT INTO workflow_runs VALUES(?,?,?,?,?,?,?,?)").run(
        mapped(run.id),
        c.workspaceId,
        mapped(run.actorId),
        newMatterId,
        mapped(run.templateId),
        run.data,
        run.status,
        run.created,
      );
    for (const schedule of scheduleRecords)
      db.prepare(
        "INSERT INTO workflow_schedules VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        mapped(schedule.id),
        c.workspaceId,
        mapped(schedule.actorId),
        newMatterId,
        mapped(schedule.templateId),
        schedule.input,
        schedule.intervalMinutes,
        schedule.nextAt,
        0,
        schedule.lastRunId,
        schedule.lastError,
        schedule.created,
      );
    for (const operation of operations)
      db.prepare("INSERT INTO legal_operations VALUES(?,?,?,?,?)").run(
        mapped(operation.id),
        c.workspaceId,
        newMatterId,
        operation.kind,
        JSON.stringify(operation.record),
      );
    for (const publication of publications)
      db.prepare(
        "INSERT INTO portal_publications VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        mapped(publication.id),
        c.workspaceId,
        newMatterId,
        publication.title,
        publication.kind,
        mapped(publication.documentId),
        publication.sourceHash,
        publication.content,
        JSON.stringify(publication.recipients),
        publication.created,
        publication.publisher,
        publication.revoked ? 1 : 0,
      );
    for (const job of jobRecords)
      db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
        mapped(job.id),
        c.workspaceId,
        mapped(job.userId),
        newMatterId,
        job.kind,
        job.payload,
        job.status,
        job.result,
        job.error,
        job.created,
        job.updated,
      );
    for (const comment of comments)
      db.prepare("INSERT INTO draft_comments VALUES(?,?,?,?,?,?,?)").run(
        mapped(comment.id),
        c.workspaceId,
        mapped(comment.draftId),
        comment.author,
        comment.body,
        comment.resolved ? 1 : 0,
        comment.created,
      );
    for (const checkpoint of checkpoints)
      db.prepare("INSERT INTO draft_checkpoints VALUES(?,?,?,?,?,?,?)").run(
        mapped(checkpoint.id),
        c.workspaceId,
        mapped(checkpoint.draftId),
        checkpoint.author,
        checkpoint.name,
        checkpoint.content,
        checkpoint.created,
      );
    for (const suggestion of suggestions)
      db.prepare("INSERT INTO draft_suggestions VALUES(?,?,?,?)").run(
        mapped(suggestion.id),
        c.workspaceId,
        mapped(suggestion.draftId),
        JSON.stringify(suggestion.suggestion),
      );
    for (const watch of watchRecords)
      db.prepare("INSERT INTO research_watches VALUES(?,?,?,?,?,?,?)").run(
        mapped(watch.id),
        c.workspaceId,
        watch.actorId,
        newMatterId,
        watch.data,
        watch.nextScan,
        0,
      );
    if (manifest.originalsIncluded)
      for (const original of originals.retained) {
        const bytes = files.get(original.path).data;
        if (
          bytes.length !== original.bytes ||
          sha256(bytes) !== original.sha256
        )
          throw fail(
            409,
            "A retained original failed its integrity check. The matter was not restored.",
          );
        db.prepare("INSERT INTO document_originals VALUES(?,?,?,?,?,?,?)").run(
          c.workspaceId,
          mapped(original.documentId),
          newMatterId,
          original.name,
          original.mime,
          original.sha256,
          bytes,
        );
      }

    // State-blob collections. Text lives here, not in separate tables.
    c.state.matters ||= [];
    c.state.documents ||= [];
    c.state.messages ||= [];
    c.state.reviews ||= [];
    c.state.drafts ||= [];
    c.state.tasks ||= [];
    c.state.skills ||= [];
    c.state.activity ||= [];
    c.state.matters.push({ ...mapped(matter) });
    c.state.skills.push(...skills.map((skill) => ({ ...mapped(skill) })));
    c.state.documents.push(
      ...documents.map((document) => ({
        ...mapped(document),
        text: sourceText(document),
      })),
    );
    c.state.messages.push(...messages.map((message) => mapped(message)));
    c.state.reviews.push(...reviews.map((review) => mapped(review)));
    c.state.drafts.push(
      ...drafts.map((draft) => ({
        ...mapped(draft),
        content: sourceText(draft),
      })),
    );
    c.state.tasks.push(...tasks.map((task) => mapped(task)));
    c.state.activity = [
      {
        id: randomUUID(),
        action: `Restored matter: ${matter.name}`,
        date: new Date().toISOString(),
      },
      ...c.state.activity,
    ].slice(0, 100);
    c.audit(c.workspaceId, c.actor, "matter.archive.restored", newMatterId);
    persist();

    counts.documents = documents.length;
    counts.messages = messages.length;
    counts.reviews = reviews.length;
    counts.drafts = drafts.length;
    counts.tasks = tasks.length;
    counts.skills = skills.length;
    counts.comparisons = comparisons.length;
    counts.researchWatches = watchRecords.length;
    counts.workflowRuns = runRecords.length;
    counts.workflowRunsCancelled = pausedRuns.length;
    counts.workflowSchedules = scheduleRecords.length;
    counts.workflowTemplates = templates.length;
    counts.legalOperations = operations.length;
    counts.portalPublications = publications.length;
    counts.jobs = jobs.length;
    counts.jobsRestoredAsFailed = pendingJobs.length;
    counts.draftComments = comments.length;
    counts.draftCheckpoints = checkpoints.length;
    counts.draftSuggestions = suggestions.length;
    counts.originals = manifest.originalsIncluded
      ? originals.retained.length
      : 0;
    counts.auditRowsNotRestored = audit.available ? audit.rows.length : 0;
    return {
      matter: {
        id: newMatterId,
        name: matter.name,
        client: matter.client || "",
      },
      mode: manifest.mode,
      counts,
      warnings: warnings.filter(
        (warning, index, all) => all.indexOf(warning) === index,
      ),
    };
  }

  function reply(res, error) {
    if (error?.status) {
      res.status(error.status).json({ error: error.message });
      return true;
    }
    return false;
  }
  function install(app) {
    const restoreUpload = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: RESTORE_MAX_ARCHIVE_BYTES,
        files: 1,
        fields: 2,
        fieldSize: 256,
      },
    });
    app.post(
      "/api/matters/archive/restore",
      (req, res, next) => {
        restoreUpload.single("archive")(req, res, (error) => {
          if (error instanceof multer.MulterError)
            return res
              .status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
              .json({
                error:
                  error.code === "LIMIT_FILE_SIZE"
                    ? `The archive exceeds the ${mib(RESTORE_MAX_ARCHIVE_BYTES)} restore limit.`
                    : "Send the archive ZIP in the archive field.",
              });
          if (error) return next(error);
          if (!req.file || !req.file.buffer?.length)
            return res
              .status(400)
              .json({ error: "Send the archive ZIP in the archive field." });
          next();
        });
      },
      (req, res, next) => {
        try {
          const flag = String(req.body?.newIds ?? "").toLowerCase();
          const result = restore(req.file.buffer, {
            newIds: flag === "1" || flag === "true",
          });
          res.set("Cache-Control", "no-store");
          res.json(result);
        } catch (error) {
          if (!reply(res, error)) next(error);
        }
      },
    );
    app.get("/api/matters/:id/archive/preview", (req, res, next) => {
      try {
        res.set("Cache-Control", "no-store");
        res.json(preview(req.params.id, { now: Date.now() }));
      } catch (error) {
        if (!reply(res, error)) next(error);
      }
    });
    app.get("/api/matters/:id/archive", (req, res, next) => {
      try {
        const originals = String(req.query.originals ?? "0");
        if (!["0", "1", "false", "true"].includes(originals))
          throw fail(400, "Use originals=0 or originals=1.");
        const archive = build(req.params.id, {
          originals: originals === "1" || originals === "true",
          now: Date.now(),
          identity: {
            userId: req.user.id,
            email: req.user.email || "",
            role: req.user.role,
          },
        });
        res.set({
          "Cache-Control": "private, no-store",
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${archive.filename}"`,
          "Content-Length": String(archive.buffer.length),
          "X-Content-Type-Options": "nosniff",
          "X-Counsel-Archive-SHA256": archive.digest,
        });
        res.send(archive.buffer);
      } catch (error) {
        if (!reply(res, error)) next(error);
      }
    });
  }
  return { build, install, preview, restore };
}

function matterName(value) {
  return safeName(value, "matter", 60);
}

module.exports = {
  FORMAT,
  MAX_AUDIT_ROWS,
  MAX_ENTRIES,
  MAX_METADATA_BYTES,
  MAX_ORIGINAL_BYTES,
  RESTORE_MAX_ARCHIVE_BYTES,
  VERSION,
  createMatterArchive,
  safeName,
};
