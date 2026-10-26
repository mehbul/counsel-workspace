const { createHash } = require("node:crypto");
const { context } = require("./security");
const { buildZip, safeArchivePath } = require("./zip");

const FORMAT = "counsel-matter-archive";
const VERSION = 1;
const MAX_METADATA_BYTES = 128 * 1024 * 1024;
const MAX_ORIGINAL_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 4_000;
const MAX_AUDIT_ROWS = 10_000;

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
      "current definitions. There is no import or restore command. Draft bodies are exported as plain text.",
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
  function reply(res, error) {
    if (error?.status) {
      res.status(error.status).json({ error: error.message });
      return true;
    }
    return false;
  }
  function install(app) {
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
  return { build, install, preview };
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
  VERSION,
  createMatterArchive,
  safeName,
};
