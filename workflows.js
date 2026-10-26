const { randomUUID } = require("node:crypto");
const { z } = require("zod");
const { context } = require("./security");
const text = (n) => z.string().trim().min(1).max(n);
const approvalPolicy = z
  .object({
    independent: z.boolean().default(false),
    requiredApprovals: z.number().int().min(1).max(2).default(1),
  })
  .strict();
const policyFor = (step) => ({
  independent: false,
  requiredApprovals: 1,
  ...step.approvalPolicy,
});
const step = z
  .object({
    kind: z.enum(["search", "review", "draft", "task", "approval"]),
    name: text(200),
    prompt: z.string().max(20000).optional(),
    columns: z.array(text(500)).min(1).max(12).optional(),
    skillId: z.string().uuid().optional(),
    approvalPolicy: approvalPolicy.optional(),
    condition: z
      .object({
        step: z.number().int().min(0).max(11),
        operator: z.enum(["has_evidence", "no_evidence"]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (s) => s.kind !== "review" || s.columns?.length,
    "Review steps need columns",
  )
  .refine(
    (s) => s.kind === "approval" || !s.approvalPolicy,
    "Approval policies belong only to approval steps",
  );
const definition = z
  .object({
    name: text(200),
    description: z.string().max(2000).default(""),
    steps: z.array(step).min(1).max(12),
  })
  .strict();
function validateConditions(d) {
  for (const [index, step] of d.steps.entries()) {
    if (!step.condition) continue;
    const source = d.steps[step.condition.step];
    if (
      step.kind === "approval" ||
      step.condition.step >= index ||
      !["search", "review"].includes(source?.kind)
    )
      throw Object.assign(
        Error(
          "Conditions must refer to an earlier search or review step; approval steps cannot be conditional.",
        ),
        { status: 400 },
      );
  }
  return d;
}
const now = () => new Date().toISOString();
const error = (status, message) => Object.assign(Error(message), { status });
function installWorkflows(app, db, security, save, tools) {
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_templates(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,definition TEXT NOT NULL,version INTEGER NOT NULL,updated TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,actor TEXT NOT NULL,matter_id TEXT NOT NULL,template_id TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS legal_operations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,matter_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS skill_versions(id TEXT NOT NULL,workspace_id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(id,workspace_id,version));
 UPDATE workflow_runs SET status='queued' WHERE status='running';`);
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof z.ZodError)
        return res
          .status(400)
          .json({ error: e.issues.map((i) => i.message).join("; ") });
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  };
  const c = () => context.getStore();
  const canMatter = (id) => c().state.matters.some((m) => m.id === id);
  const audit = (action, resource) =>
    security.audit(c().workspaceId, c().actor, action, resource);
  function row(table, id) {
    return db
      .prepare(`SELECT * FROM ${table} WHERE id=? AND workspace_id=?`)
      .get(id, c().workspaceId);
  }
  function getRun(id) {
    const r = row("workflow_runs", id);
    if (!r || !canMatter(r.matter_id)) throw error(404, "Run not found.");
    const run = JSON.parse(r.data);
    run.status = r.status;
    run.initiatorId ||= r.actor;
    return describeApprovals(run);
  }
  function eligibleApprovers(matterId) {
    // Context is request-local and workspace writes are serialized. Do not retain
    // this cache across requests: revocation must affect the next operation.
    const cache = (c().workflowApprovers ||= new Map());
    if (!cache.has(matterId))
      cache.set(
        matterId,
        new Map(
          db
            .prepare(
              "SELECT id,email FROM users WHERE workspace_id=? AND disabled=0 AND role IN ('owner','editor') AND (role='owner' OR id IN (SELECT user_id FROM matter_access WHERE workspace_id=? AND matter_id=?))",
            )
            .all(c().workspaceId, c().workspaceId, matterId)
            .map((u) => [u.id, u]),
        ),
      );
    return cache.get(matterId);
  }
  function approvalState(run, index) {
    const policy = policyFor(run.steps[index]),
      eligible = eligibleApprovers(run.matterId),
      counted = new Set(),
      decisions = run.outputs
        .filter((o) => o.kind === "approval" && o.step === index)
        .map((o) => {
          // Old completed runs recorded email only. Match them to the current
          // member for backwards-compatible replay without treating an email as
          // the identity for any new decision.
          const actorId =
            o.actorId ||
            [...eligible.values()].find((u) => u.email === o.actor)?.id;
          const valid =
            !!actorId &&
            eligible.has(actorId) &&
            !(policy.independent && actorId === run.initiatorId);
          if (valid && o.decision === "approve") counted.add(actorId);
          return { ...o, actorId, valid };
        });
    return {
      step: index,
      ...policy,
      validApprovals: counted.size,
      pendingApprovals: Math.max(0, policy.requiredApprovals - counted.size),
      canApprove:
        eligible.has(c().actor) &&
        !(policy.independent && c().actor === run.initiatorId) &&
        !counted.has(c().actor),
      decisions,
    };
  }
  function describeApprovals(run) {
    run.approvalStates = run.steps.flatMap((step, index) =>
      step.kind === "approval" ? [approvalState(run, index)] : [],
    );
    run.approvalState =
      run.approvalStates.find((a) => a.step === run.stepIndex) || null;
    return run;
  }
  function assertCompletedApprovals(run) {
    const invalid = run.approvalStates.find(
      (approval) =>
        approval.step < run.stepIndex &&
        approval.validApprovals < approval.requiredApprovals,
    );
    if (invalid)
      throw Object.assign(
        error(
          409,
          "An earlier approval no longer meets its policy because reviewer access changed. Restore the required access before retrying, or cancel and start a new run for fresh approvals.",
        ),
        { code: "APPROVAL_ACCESS_CHANGED" },
      );
  }
  function putRun(run) {
    run.updated = now();
    const { approvalState, approvalStates, ...saved } = run;
    db.prepare(
      "UPDATE workflow_runs SET data=?,status=? WHERE id=? AND workspace_id=?",
    ).run(JSON.stringify(saved), run.status, run.id, c().workspaceId);
  }
  function templates() {
    return db
      .prepare(
        "SELECT * FROM workflow_templates WHERE workspace_id=? ORDER BY updated DESC",
      )
      .all(c().workspaceId)
      .map((r) => ({
        id: r.id,
        ...JSON.parse(r.definition),
        version: r.version,
      }));
  }
  function seed() {
    if (templates().length) return;
    const examples = [
      [
        "Contract diligence",
        [
          "Governing law",
          "Liability cap",
          "Assignment restrictions",
          "Termination",
        ],
      ],
      [
        "NDA first pass",
        [
          "Confidential information",
          "Duration",
          "Permitted disclosures",
          "Remedies",
        ],
      ],
      [
        "Litigation evidence review",
        [
          "Date and chronology",
          "Parties",
          "Disputed facts",
          "Supporting evidence",
        ],
      ],
    ];
    for (const [name, columns] of examples) {
      const d = {
        name,
        description:
          "Extract cited evidence, obtain approval, prepare a memorandum and assign follow-up.",
        steps: [
          { kind: "review", name: "Compare source documents", columns },
          { kind: "approval", name: "Review extracted evidence" },
          {
            kind: "draft",
            name: "Prepare memorandum",
            prompt:
              "Prepare a source-grounded memorandum covering " +
              columns.join(", ") +
              ". Instructions: {{input}}. Prior findings: {{previous}}",
          },
          {
            kind: "task",
            name: "Confirm final work product",
            prompt:
              "Review the memorandum and verify all citations before delivery.",
          },
        ],
      };
      db.prepare("INSERT INTO workflow_templates VALUES(?,?,?,?,?)").run(
        randomUUID(),
        c().workspaceId,
        JSON.stringify(d),
        1,
        now(),
      );
    }
  }
  app.get("/api/workflows", (req, res) => {
    seed();
    const runs = db
      .prepare(
        "SELECT * FROM workflow_runs WHERE workspace_id=? ORDER BY created DESC LIMIT 200",
      )
      .all(c().workspaceId)
      .filter((r) => canMatter(r.matter_id))
      .map((r) =>
        describeApprovals({
          ...JSON.parse(r.data),
          initiatorId: r.actor,
          status: r.status,
        }),
      );
    res.json({ templates: templates(), runs });
  });
  app.post(
    "/api/workflows",
    wrap(async (req, res) => {
      const d = validateConditions(definition.parse(req.body)),
        id = randomUUID();
      db.prepare("INSERT INTO workflow_templates VALUES(?,?,?,?,?)").run(
        id,
        c().workspaceId,
        JSON.stringify(d),
        1,
        now(),
      );
      audit("workflow.created", id);
      res.json({ id, ...d, version: 1 });
    }),
  );
  app.patch(
    "/api/workflows/:id",
    wrap(async (req, res) => {
      const b = z
          .object({ version: z.number().int().positive(), ...definition.shape })
          .strict()
          .parse(req.body),
        r = row("workflow_templates", req.params.id);
      if (!r) throw error(404, "Workflow not found.");
      if (r.version !== b.version)
        throw error(409, "Workflow changed. Reload before editing.");
      const { version, ...d } = b;
      validateConditions(d);
      db.prepare(
        "UPDATE workflow_templates SET definition=?,version=version+1,updated=? WHERE id=? AND workspace_id=?",
      ).run(JSON.stringify(d), now(), r.id, c().workspaceId);
      audit("workflow.updated", r.id);
      res.json({ id: r.id, ...d, version: version + 1 });
    }),
  );
  function start(templateId, b) {
    const r = row("workflow_templates", templateId);
    if (!r) throw error(404, "Workflow not found.");
    if (!canMatter(b.matterId)) throw error(404, "Matter not found.");
    const active = db
      .prepare(
        "SELECT COUNT(*) n FROM workflow_runs WHERE workspace_id=? AND status IN ('queued','running','waiting_approval')",
      )
      .get(c().workspaceId).n;
    if (active >= 20)
      throw error(
        429,
        "Finish or cancel an existing workflow before starting another.",
      );
    const d = validateConditions(JSON.parse(r.definition));
    const ids =
      b.documentIds !== undefined
        ? b.documentIds
        : c()
            .state.documents.filter(
              (x) => x.matterId === b.matterId && !x.supersededBy,
            )
            .map((x) => x.id);
    for (const id of ids)
      if (
        !c().state.documents.some(
          (x) => x.id === id && x.matterId === b.matterId,
        )
      )
        throw error(404, "Selected document not found.");
    const steps = d.steps.map((s) => {
      const skill = s.skillId
        ? c().state.skills.find((x) => x.id === s.skillId)
        : null;
      if (s.skillId && !skill) throw error(404, "Skill not found.");
      return {
        ...s,
        ...(s.kind === "approval" ? { approvalPolicy: policyFor(s) } : {}),
        artifactId: randomUUID(),
        instructions: skill?.instructions || "",
        skillVersion: skill?.version || 1,
      };
    });
    const run = {
      id: randomUUID(),
      matterId: b.matterId,
      templateId: r.id,
      templateVersion: r.version,
      name: d.name,
      initiatorId: c().actor,
      initiatorEmail: db
        .prepare("SELECT email FROM users WHERE id=?")
        .get(c().actor).email,
      steps,
      documentIds: [...new Set(ids)],
      input: b.input || "",
      outputs: [],
      stepIndex: 0,
      status: "queued",
      revision: 1,
      created: now(),
      updated: now(),
      error: null,
    };
    db.prepare("INSERT INTO workflow_runs VALUES(?,?,?,?,?,?,?,?)").run(
      run.id,
      c().workspaceId,
      c().actor,
      b.matterId,
      r.id,
      JSON.stringify(run),
      run.status,
      run.created,
    );
    audit("workflow.run.started", run.id);
    return describeApprovals(run);
  }
  const startSchema = z
    .object({
      matterId: z.string().uuid(),
      input: z.string().max(20000).default(""),
      documentIds: z.array(z.string().uuid()).max(1000).optional(),
    })
    .strict();
  app.post(
    "/api/workflows/:id/runs",
    wrap(async (req, res) =>
      res.json(start(req.params.id, startSchema.parse(req.body))),
    ),
  );
  app.get(
    "/api/workflow-runs/:id",
    wrap(async (req, res) => res.json(getRun(req.params.id))),
  );
  app.post(
    "/api/workflow-runs/:id/decision",
    wrap(async (req, res) => {
      const b = z
          .object({
            revision: z.number().int().positive(),
            action: z.enum(["approve", "reject", "cancel", "retry"]),
            note: z.string().max(5000).default(""),
          })
          .strict()
          .parse(req.body),
        run = getRun(req.params.id);
      if (!["owner", "editor"].includes(req.user.role))
        throw error(403, "Only editors and owners can decide workflow runs.");
      if (run.revision !== b.revision)
        throw error(409, "Run changed. Reload its latest status.");
      if (b.action === "retry") {
        if (run.status !== "failed")
          throw error(409, "Only failed runs can be retried.");
        run.status = "queued";
        run.error = null;
      } else if (b.action === "cancel") {
        if (["completed", "cancelled"].includes(run.status))
          throw error(409, "Run has already ended.");
        run.status = "cancelled";
      } else {
        if (run.status !== "waiting_approval")
          throw error(409, "Run is not awaiting approval.");
        if (
          !eligibleApprovers(run.matterId).has(req.user.id) ||
          (run.approvalState.independent && run.initiatorId === req.user.id)
        )
          throw error(
            403,
            "This step requires an independent reviewer with current matter access.",
          );
        if (
          run.outputs.some(
            (o) =>
              o.kind === "approval" &&
              o.step === run.stepIndex &&
              o.actorId === req.user.id,
          )
        )
          throw error(
            409,
            "This account has already decided this approval step.",
          );
        run.outputs.push({
          kind: "approval",
          step: run.stepIndex,
          decision: b.action,
          note: b.note,
          actor: req.user.email,
          actorId: req.user.id,
          created: now(),
        });
        if (b.action === "reject") run.status = "cancelled";
        else {
          const approval = approvalState(run, run.stepIndex);
          if (approval.validApprovals >= approval.requiredApprovals) {
            run.stepIndex++;
            run.status =
              run.stepIndex === run.steps.length ? "completed" : "queued";
          }
        }
      }
      run.revision++;
      putRun(run);
      audit("workflow.run." + b.action, run.id);
      res.json(describeApprovals(run));
    }),
  );
  const schedules = require("./workflow-schedules").installWorkflowSchedules(
    app,
    db,
    security,
    { start, startSchema, wrap, canMatter, row },
  );
  let working = false,
    closed = false;
  async function tick() {
    if (working || closed) return;
    await schedules.tick();
    if (working || closed) return;
    const record = db
      .prepare(
        "SELECT * FROM workflow_runs WHERE status IN ('queued','running') ORDER BY created LIMIT 1",
      )
      .get();
    if (!record) return;
    working = true;
    try {
      await security.runWorkspace(
        record.actor,
        record.workspace_id,
        async () => {
          const run = getRun(record.id);
          if (!["queued", "running"].includes(run.status)) return;
          assertCompletedApprovals(run);
          const step = run.steps[run.stepIndex];
          if (!step) {
            run.status = "completed";
            putRun(run);
            return;
          }
          const docs = run.documentIds.map((id) =>
            c().state.documents.find(
              (d) => d.id === id && d.matterId === run.matterId,
            ),
          );
          if (docs.some((d) => !d))
            throw error(404, "A selected source was removed.");
          if (step.kind === "approval") {
            run.status = "waiting_approval";
            run.revision++;
            putRun(run);
            return;
          }
          if (step.condition) {
            const source = run.outputs.find(
              (o) => o.step === step.condition.step && o.kind !== "approval",
            );
            const known =
              Number.isInteger(source?.evidenceCount) && !source.skipped;
            const matches =
              known &&
              (step.condition.operator === "has_evidence"
                ? source.evidenceCount > 0
                : source.evidenceCount === 0);
            if (!matches) {
              run.outputs.push({
                kind: step.kind,
                step: run.stepIndex,
                name: step.name,
                skipped: true,
                condition: step.condition,
                reason: known
                  ? `Condition ${step.condition.operator} on step ${step.condition.step + 1} was false (${source.evidenceCount} recorded citations).`
                  : "Referenced evidence step was skipped or has no recorded evidence count; branch cannot be evaluated.",
                created: now(),
              });
              run.stepIndex++;
              run.revision++;
              run.status =
                run.stepIndex === run.steps.length ? "completed" : "queued";
              putRun(run);
              audit("workflow.step.skipped", run.id);
              return;
            }
          }
          run.status = "running";
          putRun(run);
          const prev = run.outputs
            .filter((o) => o.kind !== "approval" && !o.skipped)
            .at(-1);
          let previous = "";
          if (prev) {
            if (prev.kind === "review") {
              const review = c().state.reviews.find(
                (r) => r.id === prev.artifactId,
              );
              previous = review?.cells.map((x) => x.value).join("\n") || "";
            } else if (prev.kind === "search")
              previous =
                c().state.messages.find((x) => x.id === prev.artifactId)
                  ?.text || "";
            else if (prev.kind === "draft")
              previous =
                c().state.drafts.find((x) => x.id === prev.artifactId)
                  ?.content || "";
          }
          const prompt = (step.prompt || step.name)
            .replace(/\{\{(input|previous)\}\}/g, (_, k) =>
              k === "input" ? run.input : previous.slice(0, 40000),
            )
            .slice(0, 60000);
          let artifact;
          if (step.kind === "review")
            artifact = await tools.createReview(
              {
                matterId: run.matterId,
                name: step.name,
                columns: step.columns,
                documentIds: run.documentIds,
              },
              step.artifactId,
            );
          if (step.kind === "draft")
            artifact = await tools.createDraft(
              {
                matterId: run.matterId,
                title: step.name,
                prompt,
                instructions: step.instructions,
                documentIds: run.documentIds,
              },
              step.artifactId,
            );
          if (step.kind === "search") {
            artifact = c().state.messages.find((x) => x.id === step.artifactId);
            if (!artifact) {
              artifact = {
                id: step.artifactId,
                matterId: run.matterId,
                query: prompt,
                ...(await tools.answer(prompt, docs, step.instructions)),
                created: now(),
              };
              c().state.messages.push(artifact);
              save();
            }
          }
          if (step.kind === "task") {
            artifact = c().state.tasks.find((x) => x.id === step.artifactId);
            if (!artifact) {
              artifact = {
                id: step.artifactId,
                matterId: run.matterId,
                title: prompt.slice(0, 500),
                status: "To do",
                owner: "Workflow follow-up",
                workflowRunId: run.id,
              };
              c().state.tasks.push(artifact);
              save();
            }
          }
          run.outputs.push({
            kind: step.kind,
            step: run.stepIndex,
            artifactId: artifact.id,
            ...(["search", "review"].includes(step.kind)
              ? {
                  evidenceCount:
                    step.kind === "review"
                      ? (artifact.cells || []).reduce(
                          (n, cell) => n + (cell.citations?.length || 0),
                          0,
                        )
                      : artifact.citations?.length || 0,
                }
              : {}),
            name: step.name,
            created: now(),
          });
          run.stepIndex++;
          run.revision++;
          run.status =
            run.stepIndex === run.steps.length ? "completed" : "queued";
          putRun(run);
          audit("workflow.step.completed", run.id);
        },
      );
    } catch (failure) {
      const latest = db
        .prepare("SELECT data FROM workflow_runs WHERE id=?")
        .get(record.id);
      const run = JSON.parse(latest.data);
      run.status = "failed";
      run.error =
        failure.code === "APPROVAL_ACCESS_CHANGED"
          ? failure.message
          : "Step failed. Check source access and provider settings. Retry preserves completed outputs.";
      run.revision++;
      run.updated = now();
      db.prepare("UPDATE workflow_runs SET data=?,status=? WHERE id=?").run(
        JSON.stringify(run),
        "failed",
        run.id,
      );
    } finally {
      working = false;
    }
  }
  const timer = setInterval(tick, 300);
  timer.unref();
  function operations(kind) {
    return db
      .prepare("SELECT * FROM legal_operations WHERE workspace_id=? AND kind=?")
      .all(c().workspaceId, kind)
      .filter((r) => canMatter(r.matter_id))
      .map((r) => JSON.parse(r.data));
  }
  function getOp(id, kind) {
    const r = row("legal_operations", id);
    if (!r || r.kind !== kind || !canMatter(r.matter_id))
      throw error(404, "Record not found.");
    return JSON.parse(r.data);
  }
  function putOp(kind, op) {
    db.prepare(
      "INSERT INTO legal_operations VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    ).run(op.id, c().workspaceId, op.matterId, kind, JSON.stringify(op));
  }
  app.get(
    "/api/matter-members",
    wrap(async (req, res) => {
      const matterId = z.string().uuid().parse(req.query.matterId);
      if (!canMatter(matterId)) throw error(404, "Matter not found.");
      res.json(
        db
          .prepare(
            "SELECT id,email,role FROM users WHERE workspace_id=? AND disabled=0 AND role IN ('owner','editor') AND (role='owner' OR id IN (SELECT user_id FROM matter_access WHERE workspace_id=? AND matter_id=?)) ORDER BY email",
          )
          .all(c().workspaceId, c().workspaceId, matterId),
      );
    }),
  );
  app.get("/api/operations", (req, res) =>
    res.json({
      intake: operations("intake"),
      monitors: operations("monitor"),
      alerts: operations("alert"),
    }),
  );
  app.post(
    "/api/intake",
    wrap(async (req, res) => {
      const b = z
        .object({
          matterId: z.string().uuid(),
          title: text(500),
          description: text(20000),
          priority: z
            .enum(["low", "normal", "high", "urgent"])
            .default("normal"),
        })
        .strict()
        .parse(req.body);
      if (!canMatter(b.matterId)) throw error(404, "Matter not found.");
      const op = {
        id: randomUUID(),
        ...b,
        status: "new",
        revision: 1,
        requester: req.user.email,
        created: now(),
        updated: now(),
      };
      putOp("intake", op);
      audit("intake.created", op.id);
      res.json(op);
    }),
  );
  app.patch(
    "/api/intake/:id",
    wrap(async (req, res) => {
      const b = z
          .object({
            revision: z.number().int().positive(),
            status: z
              .enum([
                "triaged",
                "in_progress",
                "awaiting_approval",
                "completed",
                "rejected",
              ])
              .optional(),
            assigneeId: z.string().uuid().optional(),
            resolution: z.string().max(10000).optional(),
            workflowId: z.string().uuid().optional(),
          })
          .strict()
          .parse(req.body),
        op = getOp(req.params.id, "intake");
      if (op.revision !== b.revision)
        throw error(409, "Request changed. Reload before updating.");
      if (b.assigneeId) {
        const u = db
          .prepare(
            "SELECT * FROM users WHERE id=? AND workspace_id=? AND disabled=0",
          )
          .get(b.assigneeId, c().workspaceId);
        if (
          !u ||
          u.role === "viewer" ||
          (u.role !== "owner" &&
            !db
              .prepare(
                "SELECT 1 FROM matter_access WHERE user_id=? AND workspace_id=? AND matter_id=?",
              )
              .get(u.id, c().workspaceId, op.matterId))
        )
          throw error(
            400,
            "Assignee must be an active editor with matter access.",
          );
        op.assigneeId = u.id;
        op.assignee = u.email;
      }
      const transitions = {
        new: ["triaged", "rejected"],
        triaged: ["in_progress", "rejected"],
        in_progress: ["awaiting_approval", "rejected"],
        awaiting_approval: ["in_progress", "completed", "rejected"],
        completed: [],
        rejected: [],
      };
      if (b.status && !transitions[op.status].includes(b.status))
        throw error(400, "Invalid request status transition.");
      if (b.status === "completed" && !b.resolution?.trim())
        throw error(400, "Record the approved resolution before completion.");
      if (
        b.status === "completed" &&
        op.runId &&
        getRun(op.runId).status !== "completed"
      )
        throw error(
          409,
          "Complete the linked workflow before closing this request.",
        );
      if (b.workflowId) {
        if (!["new", "triaged"].includes(op.status) || b.status)
          throw error(
            400,
            "Start a workflow from a new or triaged request without a simultaneous status change.",
          );
        if (op.runId) throw error(409, "This request already has a workflow.");
        const run = start(b.workflowId, {
          matterId: op.matterId,
          input: op.description,
        });
        op.runId = run.id;
        op.status = "in_progress";
      } else if (b.status) op.status = b.status;
      if (b.resolution !== undefined) op.resolution = b.resolution;
      op.revision++;
      op.updated = now();
      putOp("intake", op);
      audit("intake.updated", op.id);
      res.json(op);
    }),
  );
  app.post(
    "/api/monitors",
    wrap(async (req, res) => {
      const b = z
        .object({
          matterId: z.string().uuid(),
          name: text(200),
          query: text(2000),
        })
        .strict()
        .parse(req.body);
      if (!canMatter(b.matterId)) throw error(404, "Matter not found.");
      const op = {
        id: randomUUID(),
        ...b,
        seen: c()
          .state.documents.filter((d) => d.matterId === b.matterId)
          .map((d) => d.id),
        created: now(),
        lastScan: null,
      };
      putOp("monitor", op);
      audit("monitor.created", op.id);
      res.json(op);
    }),
  );
  app.post(
    "/api/monitors/:id/scan",
    wrap(async (req, res) => {
      const op = getOp(req.params.id, "monitor");
      let created = 0;
      for (const d of c().state.documents.filter(
        (d) =>
          d.matterId === op.matterId &&
          !d.supersededBy &&
          !op.seen.includes(d.id),
      )) {
        const citations = tools.retrieve(op.query, [d]);
        if (citations.length) {
          putOp("alert", {
            id: randomUUID(),
            matterId: op.matterId,
            monitorId: op.id,
            name: op.name,
            documentId: d.id,
            documentName: d.name,
            citations,
            status: "new",
            created: now(),
          });
          created++;
        }
        op.seen.push(d.id);
      }
      op.lastScan = now();
      putOp("monitor", op);
      audit("monitor.scanned", op.id);
      res.json({ created });
    }),
  );
  app.patch(
    "/api/monitor-alerts/:id",
    wrap(async (req, res) => {
      const b = z
          .object({ action: z.enum(["dismiss", "task"]) })
          .strict()
          .parse(req.body),
        op = getOp(req.params.id, "alert");
      if (b.action === "task" && !op.taskId) {
        const task = {
          id: randomUUID(),
          matterId: op.matterId,
          title: "Investigate " + op.name + ": " + op.documentName,
          status: "To do",
          owner: req.user.email,
        };
        c().state.tasks.push(task);
        save();
        op.taskId = task.id;
      }
      op.status = b.action === "task" ? "assigned" : "dismissed";
      putOp("alert", op);
      audit("monitor.alert." + b.action, op.id);
      res.json(op);
    }),
  );
  app.patch(
    "/api/skills/:id",
    wrap(async (req, res) => {
      const b = z
          .object({
            version: z.number().int().positive(),
            name: text(200),
            category: z.string().max(100).default("Custom"),
            instructions: text(20000),
          })
          .strict()
          .parse(req.body),
        skill = c().state.skills.find((s) => s.id === req.params.id);
      if (!skill) throw error(404, "Skill not found.");
      if ((skill.version || 1) !== b.version)
        throw error(409, "Skill changed. Reload before editing.");
      db.prepare("INSERT OR IGNORE INTO skill_versions VALUES(?,?,?,?,?)").run(
        skill.id,
        c().workspaceId,
        skill.version || 1,
        JSON.stringify(skill),
        now(),
      );
      Object.assign(skill, b, { version: b.version + 1 });
      save();
      db.prepare("INSERT INTO skill_versions VALUES(?,?,?,?,?)").run(
        skill.id,
        c().workspaceId,
        skill.version,
        JSON.stringify(skill),
        now(),
      );
      audit("skill.updated", skill.id);
      res.json(skill);
    }),
  );
  app.get(
    "/api/skills/:id/versions",
    wrap(async (req, res) => {
      if (!c().state.skills.some((s) => s.id === req.params.id))
        throw error(404, "Skill not found.");
      res.json(
        db
          .prepare(
            "SELECT version,data,created FROM skill_versions WHERE id=? AND workspace_id=? ORDER BY version DESC",
          )
          .all(req.params.id, c().workspaceId)
          .map((r) => ({
            ...JSON.parse(r.data),
            version: r.version,
            created: r.created,
          })),
      );
    }),
  );
  return {
    tick,
    schedules,
    list: () => ({
      templates: templates(),
      runs: db
        .prepare(
          "SELECT id FROM workflow_runs WHERE workspace_id=? ORDER BY created DESC LIMIT 200",
        )
        .all(c().workspaceId)
        .flatMap((r) => {
          const raw = row("workflow_runs", r.id);
          return canMatter(raw.matter_id) ? [getRun(r.id)] : [];
        }),
    }),
    getRun,
    start: (templateId, input) => start(templateId, startSchema.parse(input)),
    cancel: (id, revision) => {
      const run = getRun(id);
      if (run.revision !== revision)
        throw error(409, "Run changed. Reload its latest status.");
      if (["completed", "cancelled"].includes(run.status))
        throw error(409, "Run has already ended.");
      run.status = "cancelled";
      run.revision++;
      putRun(run);
      audit("workflow.run.cancel", id);
      return describeApprovals(run);
    },
    close: async () => {
      closed = true;
      clearInterval(timer);
      await schedules.close();
      while (working) await new Promise((r) => setTimeout(r, 30));
    },
  };
}
module.exports = { installWorkflows };
