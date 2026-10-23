const { z } = require("zod");
const { randomUUID } = require("node:crypto");
const { context } = require("./security");
function installDraftReview(app, db, save, collaboration) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS draft_comments(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,draft_id TEXT NOT NULL,author TEXT NOT NULL,body TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL); CREATE TABLE IF NOT EXISTS draft_checkpoints(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,draft_id TEXT NOT NULL,author TEXT NOT NULL,name TEXT NOT NULL,content TEXT NOT NULL,created TEXT NOT NULL)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS draft_suggestions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,draft_id TEXT NOT NULL,data TEXT NOT NULL)",
  );
  const access = (req, res, next) => {
    const c = context.getStore();
    const draft = c.state.drafts.find((d) => d.id === req.params.id);
    if (!draft) return res.status(404).json({ error: "Draft not found." });
    req.draft = draft;
    next();
  };
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof z.ZodError)
        return res.status(400).json({ error: "Invalid draft review input." });
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  };
  app.get("/api/drafts/:id/suggestions", access, (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT data FROM draft_suggestions WHERE workspace_id=? AND draft_id=?",
        )
        .all(req.user.workspace_id, req.draft.id)
        .map((r) => JSON.parse(r.data)),
    ),
  );
  app.post(
    "/api/drafts/:id/suggestions",
    access,
    wrap(async (req, res) => {
      const b = z
        .object({
          find: z.string().min(1).max(100000),
          replacement: z.string().max(100000),
          reason: z.string().max(5000).default(""),
        })
        .strict()
        .parse(req.body);
      if (!req.draft.content.includes(b.find))
        return res
          .status(409)
          .json({ error: "Original quote is no longer in the draft." });
      const count = db
        .prepare(
          "SELECT COUNT(*) n FROM draft_suggestions WHERE workspace_id=? AND draft_id=?",
        )
        .get(req.user.workspace_id, req.draft.id).n;
      if (count >= 1000)
        return res
          .status(429)
          .json({ error: "Draft suggestion limit reached." });
      const item = {
        id: randomUUID(),
        ...b,
        status: "pending",
        author: req.user.email,
        created: new Date().toISOString(),
      };
      db.prepare("INSERT INTO draft_suggestions VALUES(?,?,?,?)").run(
        item.id,
        req.user.workspace_id,
        req.draft.id,
        JSON.stringify(item),
      );
      const c = context.getStore();
      c.audit(c.workspaceId, c.actor, "draft.suggestion.created", item.id);
      res.json(item);
    }),
  );
  app.patch(
    "/api/drafts/:id/suggestions/:suggestionId",
    access,
    wrap(async (req, res) => {
      const b = z
        .object({ decision: z.enum(["accept", "reject"]) })
        .strict()
        .parse(req.body);
      const row = db
        .prepare(
          "SELECT data FROM draft_suggestions WHERE id=? AND workspace_id=? AND draft_id=?",
        )
        .get(req.params.suggestionId, req.user.workspace_id, req.draft.id);
      if (!row) return res.status(404).json({ error: "Suggestion not found." });
      const item = JSON.parse(row.data);
      if (item.status !== "pending")
        return res
          .status(409)
          .json({ error: "This suggestion was already decided." });
      if (b.decision === "accept") {
        checkpoint(req, "Before accepting suggestion");
        collaboration.replaceText(req.draft, item.find, item.replacement);
      }
      item.status = b.decision === "accept" ? "accepted" : "rejected";
      item.reviewer = req.user.email;
      item.decided = new Date().toISOString();
      db.prepare(
        "UPDATE draft_suggestions SET data=? WHERE id=? AND workspace_id=?",
      ).run(JSON.stringify(item), item.id, req.user.workspace_id);
      const c = context.getStore();
      c.audit(
        c.workspaceId,
        c.actor,
        "draft.suggestion." + item.status,
        item.id,
      );
      res.json(item);
    }),
  );
  app.get("/api/drafts/:id/comments", access, (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT id,author,body,resolved,created FROM draft_comments WHERE workspace_id=? AND draft_id=? ORDER BY created",
        )
        .all(req.user.workspace_id, req.draft.id),
    ),
  );
  app.post(
    "/api/drafts/:id/comments",
    access,
    wrap(async (req, res) => {
      const b = z
          .object({ body: z.string().trim().min(1).max(5000) })
          .parse(req.body),
        id = randomUUID();
      db.prepare("INSERT INTO draft_comments VALUES(?,?,?,?,?,0,?)").run(
        id,
        req.user.workspace_id,
        req.draft.id,
        req.user.email,
        b.body,
        new Date().toISOString(),
      );
      const c = context.getStore();
      c.audit(c.workspaceId, c.actor, "draft.comment.created", req.draft.id);
      res.json({ id });
    }),
  );
  app.patch(
    "/api/drafts/:id/comments/:commentId",
    access,
    wrap(async (req, res) => {
      const b = z.object({ resolved: z.boolean() }).parse(req.body);
      const result = db
        .prepare(
          "UPDATE draft_comments SET resolved=? WHERE id=? AND workspace_id=? AND draft_id=?",
        )
        .run(
          b.resolved ? 1 : 0,
          req.params.commentId,
          req.user.workspace_id,
          req.draft.id,
        );
      if (!result.changes)
        return res.status(404).json({ error: "Comment not found." });
      res.json({ ok: true });
    }),
  );
  app.get("/api/drafts/:id/checkpoints", access, (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT id,name,author,created FROM draft_checkpoints WHERE workspace_id=? AND draft_id=? ORDER BY created DESC LIMIT 100",
        )
        .all(req.user.workspace_id, req.draft.id),
    ),
  );
  function checkpoint(req, name) {
    const id = randomUUID();
    db.prepare("INSERT INTO draft_checkpoints VALUES(?,?,?,?,?,?,?)").run(
      id,
      req.user.workspace_id,
      req.draft.id,
      req.user.email,
      name,
      JSON.stringify({
        content: req.draft.content,
        richContent: req.draft.richContent,
      }),
      new Date().toISOString(),
    );
    return id;
  }
  app.post(
    "/api/drafts/:id/checkpoints",
    access,
    wrap(async (req, res) => {
      const b = z
        .object({ name: z.string().trim().min(1).max(200) })
        .parse(req.body);
      res.json({ id: checkpoint(req, b.name) });
    }),
  );
  app.post(
    "/api/drafts/:id/restore",
    access,
    wrap(async (req, res) => {
      const b = z.object({ checkpointId: z.string().uuid() }).parse(req.body),
        row = db
          .prepare(
            "SELECT content FROM draft_checkpoints WHERE id=? AND workspace_id=? AND draft_id=?",
          )
          .get(b.checkpointId, req.user.workspace_id, req.draft.id);
      if (!row) return res.status(404).json({ error: "Checkpoint not found." });
      checkpoint(req, "Before restore");
      collaboration.restore(req.draft, JSON.parse(row.content));
      const c = context.getStore();
      c.audit(
        c.workspaceId,
        c.actor,
        "draft.checkpoint.restored",
        req.draft.id,
      );
      res.json({ ok: true });
    }),
  );
}
module.exports = { installDraftReview };
