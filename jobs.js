const { randomUUID } = require("node:crypto");
const { context } = require("./security");
function installJobs(app, db, security, execute) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,matter_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT,created TEXT NOT NULL,updated TEXT NOT NULL); UPDATE jobs SET status='queued' WHERE status='running';`,
  );
  let working = false;
  async function tick() {
    if (working) return;
    const job = db
      .prepare(
        "SELECT * FROM jobs WHERE status='queued' ORDER BY created LIMIT 1",
      )
      .get();
    if (!job) return;
    working = true;
    try {
      db.prepare("UPDATE jobs SET status='running',updated=? WHERE id=?").run(
        new Date().toISOString(),
        job.id,
      );
      const result = await security.runWorkspace(
        job.user_id,
        job.workspace_id,
        async () => {
          if (
            !context
              .getStore()
              .state.matters.some((m) => m.id === job.matter_id)
          )
            throw Error("Matter access revoked");
          return execute(job.kind, JSON.parse(job.payload), job.id);
        },
      );
      db.prepare(
        "UPDATE jobs SET status='completed',result=?,updated=? WHERE id=?",
      ).run(JSON.stringify(result), new Date().toISOString(), job.id);
    } catch {
      db.prepare(
        "UPDATE jobs SET status='failed',error=?,updated=? WHERE id=?",
      ).run(
        "Run failed. Verify document access and provider configuration, then start a new run.",
        new Date().toISOString(),
        job.id,
      );
    } finally {
      working = false;
    }
  }
  const timer = setInterval(tick, 250);
  timer.unref();
  app.get("/api/jobs/:id", (req, res) => {
    const c = context.getStore();
    const j = db
      .prepare("SELECT * FROM jobs WHERE id=? AND workspace_id=? AND user_id=?")
      .get(req.params.id, c.workspaceId, c.actor);
    if (!j || !c.state.matters.some((m) => m.id === j.matter_id))
      return res.status(404).json({ error: "Run not found." });
    res.json({
      id: j.id,
      status: j.status,
      error: j.error,
      result: j.status === "completed" ? JSON.parse(j.result) : null,
    });
  });
  function enqueue(req, res, next, kind) {
    if (!kind && req.get("prefer") !== "respond-async") return next();
    const c = context.getStore();
    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE workspace_id=? AND status IN ('queued','running')",
      )
      .get(c.workspaceId).n;
    if (count >= 10)
      return res.status(429).json({
        error: "Workspace run limit reached. Wait for existing runs.",
      });
    const jobId = randomUUID(),
      now = new Date().toISOString();
    db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      jobId,
      c.workspaceId,
      c.actor,
      req.body.matterId,
      kind || (req.path.endsWith("reviews") ? "review" : "draft"),
      JSON.stringify(req.body),
      "queued",
      null,
      null,
      now,
      now,
    );
    res.status(202).json({ jobId });
  }
  app.post("/api/reviews", (req, res, next) => enqueue(req, res, next));
  app.post("/api/drafts", (req, res, next) => enqueue(req, res, next));
  return {
    tick,
    enqueue,
    close: async () => {
      clearInterval(timer);
      while (working) await new Promise((r) => setTimeout(r, 50));
    },
  };
}
module.exports = { installJobs };
