const { randomUUID } = require("node:crypto");
const { z } = require("zod");
const { context } = require("./security");

function diffText(before, after, maxTokens = 1200) {
  const tokenize = (value) => value.match(/\s+|[^\s]+/gu) || [];
  const originalA = tokenize(before),
    originalB = tokenize(after);
  const a = originalA.slice(0, maxTokens),
    b = originalB.slice(0, maxTokens),
    width = b.length + 1;
  const matrix = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      matrix[i * width + j] =
        a[i] === b[j]
          ? matrix[(i + 1) * width + j + 1] + 1
          : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
  const parts = [];
  function push(kind, text) {
    if (parts.at(-1)?.kind === kind) parts.at(-1).text += text;
    else parts.push({ kind, text });
  }
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push("equal", a[i++]);
      j++;
    } else if (
      j < b.length &&
      (i === a.length ||
        matrix[i * width + j + 1] > matrix[(i + 1) * width + j])
    )
      push("added", b[j++]);
    else push("removed", a[i++]);
  }
  return {
    equal: before === after,
    truncated: a.length < originalA.length || b.length < originalB.length,
    parts,
    beforeExcerpt: a.join(""),
    afterExcerpt: b.join(""),
  };
}

function compareDocuments(
  documents,
  questions,
  retrieve = require("./retrieval").retrieve,
) {
  if (documents.length < 2 || documents.length > 6)
    throw Error("Compare two to six documents.");
  const rows = questions.map((question) => {
    const findings = documents.map((d) => {
      const sources = retrieve(question, [d], {
        limit: 2,
        maxPerDocument: 2,
        maxChars: 3000,
        includeSuperseded: true,
      });
      return {
        documentId: d.id,
        documentName: d.name,
        status: sources.length ? "passages_found" : "no_match",
        sources,
      };
    });
    const left = findings[0].sources[0],
      right = findings[1].sources[0];
    return {
      question,
      coverage: {
        matched: findings.filter((f) => f.sources.length).length,
        total: documents.length,
      },
      findings,
      diff: left && right ? diffText(left.text, right.text) : null,
    };
  });
  return {
    documents: documents.map((d) => ({
      id: d.id,
      name: d.name,
      previousVersion: !!d.supersededBy,
    })),
    rows,
    notice:
      "This compares retrieved source passages, not legal meaning. No match does not establish that a provision is absent. Highlighted changes compare the first two selected documents; open every source before reaching a conclusion.",
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return (
    '"' +
    (/^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text) ? "'" : "") +
    text.replaceAll('"', '""') +
    '"'
  );
}
function comparisonCsv(report) {
  return [
    ["Question", ...report.documents.map((d) => d.name)],
    ...report.rows.map((r) => [
      r.question,
      ...r.findings.map((f) =>
        f.sources.length
          ? f.sources
              .map((c) => `Paragraph ${c.paragraph}: ${c.text}`)
              .join("\n\n")
          : "No matching passage found — inspect source",
      ),
    ]),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

function installComparisons(app, db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS document_comparisons(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,matter_id TEXT NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL)",
  );
  const schema = z
    .object({
      matterId: z.string().uuid(),
      name: z.string().trim().min(1).max(200),
      documentIds: z.array(z.string().uuid()).min(2).max(6),
      questions: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
    })
    .strict();
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof z.ZodError)
        return res
          .status(400)
          .json({ error: e.issues.map((i) => i.message).join("; ") });
      next(e);
    }
  };
  const visible = (row) =>
    row && context.getStore().state.matters.some((m) => m.id === row.matter_id);
  const get = (id) =>
    db
      .prepare(
        "SELECT * FROM document_comparisons WHERE id=? AND workspace_id=?",
      )
      .get(id, context.getStore().workspaceId);
  app.get("/api/comparisons", (req, res) => {
    const rows = db
      .prepare(
        "SELECT id,matter_id,created,json_extract(data,'$.name') name,json_array_length(data,'$.documents') document_count,json_array_length(data,'$.rows') question_count FROM document_comparisons WHERE workspace_id=? ORDER BY created DESC LIMIT 500",
      )
      .all(context.getStore().workspaceId)
      .filter(visible);
    res.json(
      rows.map((r) => ({
        id: r.id,
        matterId: r.matter_id,
        name: r.name,
        created: r.created,
        documentCount: r.document_count,
        questionCount: r.question_count,
      })),
    );
  });
  app.post(
    "/api/comparisons",
    wrap(async (req, res) => {
      const b = schema.parse(req.body),
        c = context.getStore();
      if (!c.state.matters.some((m) => m.id === b.matterId))
        return res.status(404).json({ error: "Matter not found." });
      if (new Set(b.documentIds).size !== b.documentIds.length)
        return res
          .status(400)
          .json({ error: "Select distinct source documents." });
      const documents = b.documentIds.map((id) =>
        c.state.documents.find((d) => d.id === id && d.matterId === b.matterId),
      );
      if (documents.some((d) => !d))
        return res.status(404).json({ error: "Source document not found." });
      if (
        db
          .prepare(
            "SELECT COUNT(*) n FROM document_comparisons WHERE workspace_id=?",
          )
          .get(c.workspaceId).n >= 500
      )
        return res
          .status(429)
          .json({ error: "Workspace comparison limit reached." });
      const report = {
        id: randomUUID(),
        matterId: b.matterId,
        name: b.name,
        created: new Date().toISOString(),
        ...compareDocuments(documents, b.questions),
      };
      db.prepare("INSERT INTO document_comparisons VALUES(?,?,?,?,?)").run(
        report.id,
        c.workspaceId,
        b.matterId,
        JSON.stringify(report),
        report.created,
      );
      c.audit(c.workspaceId, c.actor, "comparison.created", report.id);
      res.json(report);
    }),
  );
  app.get("/api/comparisons/:id", (req, res) => {
    const row = get(req.params.id);
    if (!visible(row))
      return res.status(404).json({ error: "Comparison not found." });
    const report = JSON.parse(row.data),
      docs = context.getStore().state.documents;
    report.unavailableSources = report.documents
      .filter((d) => !docs.some((s) => s.id === d.id))
      .map((d) => d.id);
    res.json(report);
  });
  app.get("/api/comparisons/:id/export", (req, res) => {
    const row = get(req.params.id);
    if (!visible(row))
      return res.status(404).json({ error: "Comparison not found." });
    res
      .set("Content-Disposition", 'attachment; filename="comparison.csv"')
      .type("text/csv")
      .send(comparisonCsv(JSON.parse(row.data)));
  });
}
module.exports = {
  diffText,
  compareDocuments,
  comparisonCsv,
  installComparisons,
};
