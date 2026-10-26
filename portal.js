const { randomUUID, createHash } = require("node:crypto");
const { z } = require("zod");
const { context } = require("./security");

const fail = (status, message) => Object.assign(Error(message), { status });
const digest = (text) => createHash("sha256").update(text).digest("hex");
const text = (max) => z.string().trim().min(1).max(max);

function installPortal(app, db, security) {
  db.exec(`CREATE TABLE IF NOT EXISTS portal_publications(
    id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,matter_id TEXT NOT NULL,
    title TEXT NOT NULL,kind TEXT NOT NULL,document_id TEXT,source_hash TEXT,
    content TEXT NOT NULL,recipients TEXT NOT NULL,created TEXT NOT NULL,
    publisher TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS portal_workspace ON portal_publications(workspace_id,created);`);
  const current = () => context.getStore();
  const wrap = (fn) => (req, res, next) => {
    try {
      fn(req, res);
    } catch (e) {
      if (e instanceof z.ZodError)
        return res
          .status(400)
          .json({ error: e.issues.map((i) => i.message).join("; ") });
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  };
  function manager() {
    if (!["owner", "editor"].includes(current().role))
      throw fail(403, "Owner or editor access required.");
  }
  function guest() {
    if (current().role !== "guest")
      throw fail(403, "Client guest account required.");
  }
  const canMatter = (id) => current().state.matters.some((m) => m.id === id);
  const get = (id) =>
    db
      .prepare(
        "SELECT * FROM portal_publications WHERE id=? AND workspace_id=?",
      )
      .get(id, current().workspaceId);
  function availability() {
    const sources = new Map(current().state.documents.map((d) => [d.id, d]));
    const hashes = new Map();
    return (row) => {
      if (row.kind !== "document") return true;
      const document = sources.get(row.document_id);
      if (!document || document.matterId !== row.matter_id) return false;
      if (!hashes.has(document.id))
        hashes.set(document.id, digest(document.text));
      return hashes.get(document.id) === row.source_hash;
    };
  }
  const fields =
    "id,matter_id,title,kind,document_id,source_hash,recipients,created,publisher,revoked";
  function metadata(row) {
    return {
      id: row.id,
      matterId: row.matter_id,
      title: row.title,
      kind: row.kind,
      created: row.created,
    };
  }
  app.get(
    "/api/portal/items",
    wrap((req, res) => {
      guest();
      const available = availability();
      const items = db
        .prepare(
          `SELECT ${fields} FROM portal_publications WHERE workspace_id=? AND revoked=0 ORDER BY created DESC LIMIT 500`,
        )
        .all(current().workspaceId)
        .filter(
          (row) =>
            canMatter(row.matter_id) &&
            JSON.parse(row.recipients).includes(current().actor) &&
            available(row),
        )
        .map(metadata);
      res.json({ items });
    }),
  );
  app.get(
    "/api/portal/items/:id",
    wrap((req, res) => {
      guest();
      const row = get(req.params.id);
      if (
        !row ||
        row.revoked ||
        !canMatter(row.matter_id) ||
        !JSON.parse(row.recipients).includes(current().actor) ||
        !availability()(row)
      )
        throw fail(404, "Published item not available.");
      res.json({
        ...metadata(row),
        content: row.content,
        format: "plain_text",
        snapshot: true,
      });
    }),
  );
  app.get(
    "/api/portal/recipients",
    wrap((req, res) => {
      manager();
      const matterId = z.string().uuid().parse(req.query.matterId);
      if (!canMatter(matterId)) throw fail(404, "Matter not found.");
      res.json(
        db
          .prepare(
            "SELECT u.id,u.email FROM users u JOIN matter_access a ON a.user_id=u.id AND a.workspace_id=u.workspace_id WHERE u.workspace_id=? AND u.role='guest' AND u.disabled=0 AND a.matter_id=? ORDER BY u.email",
          )
          .all(current().workspaceId, matterId),
      );
    }),
  );
  app.get(
    "/api/portal/manage",
    wrap((req, res) => {
      manager();
      const available = availability();
      res.json(
        db
          .prepare(
            `SELECT ${fields} FROM portal_publications WHERE workspace_id=? ORDER BY created DESC LIMIT 500`,
          )
          .all(current().workspaceId)
          .filter((row) => canMatter(row.matter_id))
          .map((row) => ({
            ...metadata(row),
            documentId: row.document_id,
            recipientIds: JSON.parse(row.recipients),
            revoked: !!row.revoked,
            sourceAvailable: available(row),
          })),
      );
    }),
  );
  const publication = z
    .object({
      matterId: z.string().uuid(),
      title: text(200),
      kind: z.enum(["document", "reviewed_text"]),
      documentId: z.string().uuid().optional(),
      content: text(200000).optional(),
      recipientIds: z.array(z.string().uuid()).min(1).max(50),
      confirmedReviewed: z.literal(true),
    })
    .strict()
    .refine(
      (b) =>
        b.kind === "document"
          ? !!b.documentId && b.content === undefined
          : !!b.content && b.documentId === undefined,
      "Select a document or provide reviewed text.",
    );
  app.post(
    "/api/portal/manage",
    wrap((req, res) => {
      manager();
      const b = publication.parse(req.body),
        c = current();
      if (!canMatter(b.matterId)) throw fail(404, "Matter not found.");
      if (new Set(b.recipientIds).size !== b.recipientIds.length)
        throw fail(400, "Select distinct recipients.");
      if (
        db
          .prepare(
            "SELECT COUNT(*) n FROM portal_publications WHERE workspace_id=?",
          )
          .get(c.workspaceId).n >= 500
      )
        throw fail(429, "Workspace publication limit reached.");
      const recipients = db
        .prepare(
          "SELECT u.id FROM users u JOIN matter_access a ON a.user_id=u.id AND a.workspace_id=u.workspace_id WHERE u.workspace_id=? AND u.role='guest' AND u.disabled=0 AND a.matter_id=?",
        )
        .all(c.workspaceId, b.matterId);
      if (b.recipientIds.some((id) => !recipients.some((u) => u.id === id)))
        throw fail(404, "Select active client guests assigned to this matter.");
      const source =
        b.kind === "document"
          ? c.state.documents.find(
              (d) => d.id === b.documentId && d.matterId === b.matterId,
            )
          : null;
      if (b.kind === "document" && !source)
        throw fail(404, "Source document not found.");
      if (source && source.text.length > 200000)
        throw fail(
          400,
          "Publish a document of at most 200,000 characters or a reviewed extract.",
        );
      const row = {
        id: randomUUID(),
        matter_id: b.matterId,
        title: b.title,
        kind: b.kind,
        created: new Date().toISOString(),
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "INSERT INTO portal_publications VALUES(?,?,?,?,?,?,?,?,?,?,?,0)",
        ).run(
          row.id,
          c.workspaceId,
          row.matter_id,
          row.title,
          row.kind,
          source?.id || null,
          source ? digest(source.text) : null,
          source ? source.text : b.content,
          JSON.stringify(b.recipientIds),
          row.created,
          c.actor,
        );
        security.audit(c.workspaceId, c.actor, "portal.published", row.id);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      res.json({
        ...metadata(row),
        recipientIds: b.recipientIds,
        reviewedBy: c.actor,
      });
    }),
  );
  app.post(
    "/api/portal/manage/:id/revoke",
    wrap((req, res) => {
      manager();
      z.object({}).strict().parse(req.body);
      const row = get(req.params.id),
        c = current();
      if (!row || !canMatter(row.matter_id))
        throw fail(404, "Publication not found.");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE portal_publications SET revoked=1 WHERE id=? AND workspace_id=?",
        ).run(row.id, c.workspaceId);
        security.audit(c.workspaceId, c.actor, "portal.revoked", row.id);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      res.json({ ok: true });
    }),
  );
}
module.exports = { installPortal };
