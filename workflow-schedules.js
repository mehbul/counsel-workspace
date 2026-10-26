const { randomUUID } = require("node:crypto");
const { z } = require("zod");
const { context } = require("./security");
const fail = (status, message) => Object.assign(Error(message), { status });
function installWorkflowSchedules(
  app,
  db,
  security,
  { start, startSchema, wrap, canMatter },
) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS workflow_schedules(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,actor TEXT NOT NULL,matter_id TEXT NOT NULL,template_id TEXT NOT NULL,input TEXT NOT NULL,interval_minutes INTEGER NOT NULL,next_at INTEGER NOT NULL,enabled INTEGER NOT NULL,last_run_id TEXT,last_error TEXT,created TEXT NOT NULL);`,
  );
  const c = () => context.getStore();
  const publicRow = (r) => ({
    id: r.id,
    matterId: r.matter_id,
    templateId: r.template_id,
    actorId: r.actor,
    intervalMinutes: r.interval_minutes,
    nextAt: r.next_at,
    enabled: !!r.enabled,
    lastRunId: r.last_run_id,
    lastError: r.last_error,
    created: r.created,
  });
  const list = () =>
    db
      .prepare(
        "SELECT * FROM workflow_schedules WHERE workspace_id=? ORDER BY created DESC LIMIT 100",
      )
      .all(c().workspaceId)
      .filter((r) => canMatter(r.matter_id))
      .map(publicRow);
  app.get("/api/workflow-schedules", (req, res) => res.json(list()));
  app.post(
    "/api/workflow-schedules",
    wrap(async (req, res) => {
      const b = z
        .object({
          templateId: z.string().uuid(),
          run: startSchema,
          intervalMinutes: z.number().int().min(60).max(525600),
          enabled: z.boolean().default(false),
        })
        .strict()
        .parse(req.body);
      if (!canMatter(b.run.matterId)) throw fail(404, "Matter not found.");
      if (
        !db
          .prepare(
            "SELECT 1 FROM workflow_templates WHERE id=? AND workspace_id=?",
          )
          .get(b.templateId, c().workspaceId)
      )
        throw fail(404, "Workflow not found.");
      for (const id of b.run.documentIds || [])
        if (
          !c().state.documents.some(
            (d) => d.id === id && d.matterId === b.run.matterId,
          )
        )
          throw fail(404, "Selected document not found.");
      if (
        db
          .prepare(
            "SELECT COUNT(*) n FROM workflow_schedules WHERE workspace_id=?",
          )
          .get(c().workspaceId).n >= 50
      )
        throw fail(429, "Workspace schedule limit reached (50).");
      const id = randomUUID();
      db.prepare(
        "INSERT INTO workflow_schedules VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,?)",
      ).run(
        id,
        c().workspaceId,
        c().actor,
        b.run.matterId,
        b.templateId,
        JSON.stringify(b.run),
        b.intervalMinutes,
        Date.now() + b.intervalMinutes * 60000,
        b.enabled ? 1 : 0,
        new Date().toISOString(),
      );
      security.audit(
        c().workspaceId,
        c().actor,
        "workflow.schedule.created",
        id,
      );
      res.json(
        publicRow(
          db.prepare("SELECT * FROM workflow_schedules WHERE id=?").get(id),
        ),
      );
    }),
  );
  app.patch(
    "/api/workflow-schedules/:id",
    wrap(async (req, res) => {
      const b = z.object({ enabled: z.boolean() }).strict().parse(req.body);
      const r = db
        .prepare(
          "SELECT * FROM workflow_schedules WHERE id=? AND workspace_id=?",
        )
        .get(req.params.id, c().workspaceId);
      if (!r || !canMatter(r.matter_id)) throw fail(404, "Schedule not found.");
      if (c().actor !== r.actor && c().role !== "owner")
        throw fail(403, "Only the schedule creator or owner can change it.");
      // Enabling restarts the interval; missed intervals are never replayed in a burst.
      db.prepare(
        "UPDATE workflow_schedules SET enabled=?, next_at=?, last_error=NULL WHERE id=?",
      ).run(b.enabled ? 1 : 0, Date.now() + r.interval_minutes * 60000, r.id);
      security.audit(
        c().workspaceId,
        c().actor,
        b.enabled ? "workflow.schedule.enabled" : "workflow.schedule.disabled",
        r.id,
      );
      res.json(
        publicRow(
          db.prepare("SELECT * FROM workflow_schedules WHERE id=?").get(r.id),
        ),
      );
    }),
  );
  let working = false;
  async function tick(time = Date.now()) {
    if (working) return;
    working = true;
    try {
      const due = db
        .prepare(
          "SELECT * FROM workflow_schedules WHERE enabled=1 AND next_at<=? ORDER BY next_at LIMIT 5",
        )
        .all(time);
      for (const candidate of due) {
        try {
          await security.runWorkspace(
            candidate.actor,
            candidate.workspace_id,
            async () => {
              const r = db
                .prepare(
                  "SELECT * FROM workflow_schedules WHERE id=? AND enabled=1 AND next_at<=?",
                )
                .get(candidate.id, time);
              if (!r) return;
              if (!canMatter(r.matter_id))
                throw fail(
                  403,
                  "Schedule creator no longer has matter access.",
                );
              const previous =
                r.last_run_id &&
                db
                  .prepare("SELECT status FROM workflow_runs WHERE id=?")
                  .get(r.last_run_id);
              if (
                previous &&
                ["queued", "running", "waiting_approval"].includes(
                  previous.status,
                )
              ) {
                db.prepare(
                  "UPDATE workflow_schedules SET next_at=?,last_error=? WHERE id=?",
                ).run(
                  time + r.interval_minutes * 60000,
                  "Previous run remains active; this occurrence was skipped.",
                  r.id,
                );
                return;
              }
              // Run creation and next occurrence advance commit together: restart cannot duplicate an occurrence.
              db.exec("BEGIN IMMEDIATE");
              try {
                const run = start(
                  r.template_id,
                  startSchema.parse(JSON.parse(r.input)),
                );
                db.prepare(
                  "UPDATE workflow_schedules SET last_run_id=?,next_at=?,last_error=NULL WHERE id=?",
                ).run(run.id, time + r.interval_minutes * 60000, r.id);
                security.audit(
                  c().workspaceId,
                  c().actor,
                  "workflow.schedule.started",
                  r.id,
                );
                db.exec("COMMIT");
              } catch (e) {
                db.exec("ROLLBACK");
                throw e;
              }
            },
          );
        } catch (e) {
          // Disable after access/configuration/limit failure; an explicit enable is needed before retry.
          db.prepare(
            "UPDATE workflow_schedules SET enabled=0,last_error=? WHERE id=?",
          ).run(
            "Schedule paused: creator access, selected sources, template or run limits need review. Re-enable after resolving the issue.",
            candidate.id,
          );
        }
      }
    } finally {
      working = false;
    }
  }
  return {
    tick,
    list,
    close: async () => {
      while (working) await new Promise((r) => setTimeout(r, 20));
    },
  };
}
module.exports = { installWorkflowSchedules };
