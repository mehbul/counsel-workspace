const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const { installSecurity, context } = require("../security");
const { installWorkflows } = require("../workflows");
test("conditional branches preserve approval gates; durable schedules recheck permissions and coalesce restart occurrences", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-schedule-"));
  process.env.DATA_DIR = folder;
  const database = path.join(folder, "workspace.db"),
    mid = randomUUID(),
    docId = randomUUID();
  let h;
  async function boot() {
    const db = new DatabaseSync(database);
    db.exec(
      "CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY,value TEXT)",
    );
    const app = express();
    app.use(express.json());
    const security = installSecurity(app, db, () => ({
      matters: [{ id: mid, name: "Matter" }],
      documents: [{ id: docId, matterId: mid, text: "Actual evidence" }],
      drafts: [],
      messages: [],
      reviews: [],
      tasks: [],
      skills: [],
      activity: [],
    }));
    const save = () => {
      const c = context.getStore();
      db.prepare("UPDATE workspaces SET value=? WHERE id=?").run(
        JSON.stringify(c.state),
        c.workspaceId,
      );
    };
    const workflows = installWorkflows(app, db, security, save, {
      answer: async (query) => ({
        text: "Search result",
        citations: query.includes("missing")
          ? []
          : [{ documentId: docId, paragraph: 1, text: "Actual evidence" }],
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let cookie = "",
      csrf = "";
    async function req(p, b, method = b ? "POST" : "GET") {
      const res = await fetch(origin + "/api/" + p, {
        method,
        headers: {
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
        },
        body: b ? JSON.stringify(b) : undefined,
      });
      if (res.headers.get("set-cookie"))
        cookie = res.headers.get("set-cookie").split(";")[0];
      const data = await res.json();
      if (data.csrf) csrf = data.csrf;
      return { status: res.status, data };
    }
    return {
      db,
      security,
      workflows,
      req,
      close: async () => {
        await workflows.close();
        await new Promise((r) => server.close(r));
        db.close();
      },
    };
  }
  try {
    h = await boot();
    await h.req("auth/setup", {
      token: fs.readFileSync(path.join(folder, "bootstrap-token"), "utf8"),
      email: "owner@schedules.test",
      password: "Owner scheduling passphrase",
      workspace: "Schedules",
    });
    const template = {
      name: "Conditional",
      steps: [
        { kind: "search", name: "Find", prompt: "missing" },
        {
          kind: "task",
          name: "Evidence branch",
          condition: { step: 0, operator: "has_evidence" },
        },
        {
          kind: "task",
          name: "Missing branch",
          condition: { step: 0, operator: "no_evidence" },
        },
        { kind: "approval", name: "Mandatory approval" },
        { kind: "task", name: "After approval" },
      ],
    };
    const made = await h.req("workflows", template);
    assert.equal(made.status, 200);
    const tid = made.data.id;
    assert.equal(
      (
        await h.req("workflows", {
          ...template,
          steps: [
            {
              kind: "approval",
              name: "Invalid",
              condition: { step: 0, operator: "has_evidence" },
            },
          ],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await h.req("workflows", {
          ...template,
          steps: [
            {
              kind: "task",
              name: "Invalid",
              condition: { step: 1, operator: "has_evidence" },
            },
            { kind: "search", name: "Later" },
          ],
        })
      ).status,
      400,
    );
    const run = (await h.req(`workflows/${tid}/runs`, { matterId: mid })).data;
    for (let i = 0; i < 5; i++) await h.workflows.tick();
    let current = (await h.req("workflow-runs/" + run.id)).data;
    assert.equal(current.status, "waiting_approval");
    assert.equal(current.outputs.find((o) => o.step === 0).evidenceCount, 0);
    assert.equal(current.outputs.find((o) => o.step === 1).skipped, true);
    assert.match(current.outputs.find((o) => o.step === 1).reason, /false/);
    assert.ok(current.outputs.find((o) => o.step === 2).artifactId);
    assert.equal(
      current.outputs.find((o) => o.step === 4),
      undefined,
    );
    const owner = h.db.prepare("SELECT * FROM users WHERE role='owner'").get();
    const schedule = (
      await h.req("workflow-schedules", {
        templateId: tid,
        run: { matterId: mid },
        intervalMinutes: 60,
        enabled: true,
      })
    ).data;
    assert.ok(schedule.id);
    assert.equal(
      (
        await h.req("workflow-schedules", {
          templateId: tid,
          run: { matterId: mid },
          intervalMinutes: 59,
          enabled: true,
        })
      ).status,
      400,
    );
    h.db
      .prepare("UPDATE workflow_schedules SET next_at=0 WHERE id=?")
      .run(schedule.id);
    await h.workflows.schedules.tick();
    let scheduled = h.db
      .prepare("SELECT * FROM workflow_schedules WHERE id=?")
      .get(schedule.id);
    assert.ok(scheduled.last_run_id);
    const first = scheduled.last_run_id;
    await h.workflows.schedules.tick();
    assert.equal(
      h.db.prepare("SELECT COUNT(*) n FROM workflow_runs").get().n,
      2,
    );
    h.db
      .prepare("UPDATE workflow_schedules SET next_at=0 WHERE id=?")
      .run(schedule.id);
    await h.workflows.schedules.tick();
    assert.equal(
      h.db
        .prepare("SELECT last_run_id FROM workflow_schedules WHERE id=?")
        .get(schedule.id).last_run_id,
      first,
    );
    assert.match(
      h.db
        .prepare("SELECT last_error FROM workflow_schedules WHERE id=?")
        .get(schedule.id).last_error,
      /active/,
    );
    // Persisted skip output and run IDs survive an actual database close/reopen.
    await h.close();
    h = null;
    h = await boot();
    await h.req("auth/login", {
      email: "owner@schedules.test",
      password: "Owner scheduling passphrase",
    });
    await h.workflows.schedules.tick();
    assert.equal(
      h.db.prepare("SELECT COUNT(*) n FROM workflow_runs").get().n,
      2,
    );
    current = (await h.req("workflow-runs/" + run.id)).data;
    assert.equal(current.outputs.filter((o) => o.skipped).length, 1);
    for (let i = 0; i < 5; i++) await h.workflows.tick();
    assert.equal(
      (await h.req("workflow-runs/" + first)).data.status,
      "waiting_approval",
    );
    assert.equal(
      (
        await h.req(
          "workflow-schedules/" + schedule.id,
          { enabled: false },
          "PATCH",
        )
      ).data.enabled,
      false,
    );
    h.db
      .prepare("UPDATE workflow_schedules SET next_at=0 WHERE id=?")
      .run(schedule.id);
    await h.workflows.schedules.tick();
    assert.equal(
      h.db.prepare("SELECT COUNT(*) n FROM workflow_runs").get().n,
      2,
    );
    await h.req(
      "workflow-schedules/" + schedule.id,
      { enabled: true },
      "PATCH",
    );
    // A later occurrence snapshots the current template; earlier runs retain their own branch outcomes.
    const withEvidence = structuredClone(template);
    withEvidence.steps[0].prompt = "actual evidence";
    assert.equal(
      (
        await h.req(
          "workflows/" + tid,
          { ...withEvidence, version: 1 },
          "PATCH",
        )
      ).status,
      200,
    );
    // Terminal prior run permits one subsequent occurrence.
    h.db
      .prepare("UPDATE workflow_runs SET status='cancelled' WHERE id=?")
      .run(first);
    h.db
      .prepare("UPDATE workflow_schedules SET next_at=0 WHERE id=?")
      .run(schedule.id);
    await h.workflows.schedules.tick();
    assert.equal(
      h.db.prepare("SELECT COUNT(*) n FROM workflow_runs").get().n,
      3,
    );
    const nextRun = h.db
      .prepare("SELECT last_run_id FROM workflow_schedules WHERE id=?")
      .get(schedule.id).last_run_id;
    for (let i = 0; i < 5; i++) await h.workflows.tick();
    const withEvidenceRun = (await h.req("workflow-runs/" + nextRun)).data;
    assert.equal(
      withEvidenceRun.outputs.find((o) => o.step === 0).evidenceCount,
      1,
    );
    assert.ok(withEvidenceRun.outputs.find((o) => o.step === 1).artifactId);
    assert.equal(
      withEvidenceRun.outputs.find((o) => o.step === 2).skipped,
      true,
    );
    assert.equal(withEvidenceRun.status, "waiting_approval");
    // Disabled membership stops new occurrences under the stored original actor.
    h.db.prepare("UPDATE users SET disabled=1 WHERE id=?").run(owner.id);
    h.db
      .prepare("UPDATE workflow_schedules SET next_at=0 WHERE id=?")
      .run(schedule.id);
    await h.workflows.schedules.tick();
    scheduled = h.db
      .prepare("SELECT * FROM workflow_schedules WHERE id=?")
      .get(schedule.id);
    assert.equal(scheduled.enabled, 0);
    assert.match(scheduled.last_error, /access/);
    assert.equal(
      h.db.prepare("SELECT COUNT(*) n FROM workflow_runs").get().n,
      3,
    );
  } finally {
    await h?.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
