const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.COUNSEL_DB = ":memory:";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "counsel-workflows-"),
);
const { app, db, jobs, workflows } = require("../server");
test("versioned workflows pause for approval, freeze inputs, resume idempotently and respect matter access", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  function client() {
    return {
      cookie: "",
      csrf: "",
      async req(p, b, method = b ? "POST" : "GET") {
        const r = await fetch(base + p, {
          method,
          headers: {
            Cookie: this.cookie,
            "X-CSRF-Token": this.csrf,
            ...(b instanceof FormData
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: b instanceof FormData ? b : b ? JSON.stringify(b) : undefined,
        });
        if (r.headers.get("set-cookie"))
          this.cookie = r.headers.get("set-cookie").split(";")[0];
        const data = await r.json();
        if (data.csrf) this.csrf = data.csrf;
        return { status: r.status, data };
      },
    };
  }
  const owner = client(),
    viewer = client(),
    editor = client();
  try {
    await owner.req("auth/setup", {
      token: fs.readFileSync(
        path.join(process.env.DATA_DIR, "bootstrap-token"),
        "utf8",
      ),
      email: "owner@workflow.test",
      password: "Owner workflow test passphrase",
      workspace: "Workflow test",
    });
    const state = (await owner.req("state")).data,
      mid = state.matters[0].id;
    const library = await owner.req("workflows");
    assert.equal(library.status, 200);
    assert.ok(library.data.templates.length >= 3);
    const definition = {
      name: "Approval diligence",
      description: "Review, approve, draft and follow up",
      steps: [
        { kind: "review", name: "Extract", columns: ["Governing law"] },
        { kind: "approval", name: "Partner approval" },
        {
          kind: "draft",
          name: "Prepare memo",
          prompt: "Governing law. {{input}}",
        },
        { kind: "task", name: "Follow up", prompt: "Check memo with partner" },
      ],
    };
    const template = (await owner.req("workflows", definition)).data;
    const run = (
      await owner.req(`workflows/${template.id}/runs`, {
        matterId: mid,
        input: "Use a clear style",
        documentIds: [state.documents[0].id],
      })
    ).data;
    assert.equal(run.status, "queued");
    const revised = await owner.req(
      `workflows/${template.id}`,
      { ...definition, name: "Changed later", version: template.version },
      "PATCH",
    );
    assert.equal(revised.status, 200);
    assert.equal(
      (
        await owner.req(
          `workflows/${template.id}`,
          { ...definition, version: template.version },
          "PATCH",
        )
      ).status,
      409,
    );
    await workflows.tick();
    await workflows.tick();
    let current = (await owner.req(`workflow-runs/${run.id}`)).data;
    assert.equal(current.status, "waiting_approval");
    assert.equal(current.name, "Approval diligence");
    assert.equal(current.documentIds.length, 1);
    assert.equal(
      (await owner.req("state")).data.reviews.find(
        (x) => x.id === current.outputs[0].artifactId,
      ).cells.length,
      1,
    );
    assert.equal(
      (
        await owner.req(`workflow-runs/${run.id}/decision`, {
          revision: current.revision - 1,
          action: "approve",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await owner.req(`workflow-runs/${run.id}/decision`, {
          revision: current.revision,
          action: "approve",
          note: "Reviewed evidence",
        })
      ).status,
      200,
    );
    await workflows.tick();
    await workflows.tick();
    current = (await owner.req(`workflow-runs/${run.id}`)).data;
    assert.equal(current.status, "completed");
    assert.ok(current.outputs.some((x) => x.kind === "draft"));
    const before = (await owner.req("state")).data;
    await workflows.tick();
    const after = (await owner.req("state")).data;
    assert.equal(before.drafts.length, after.drafts.length);
    assert.equal(before.tasks.length, after.tasks.length);
    // Simulate restart after the final side effect committed but before progress was saved.
    const replay = JSON.parse(
      db.prepare("SELECT data FROM workflow_runs WHERE id=?").get(run.id).data,
    );
    replay.stepIndex--;
    replay.outputs.pop();
    replay.status = "running";
    db.prepare("UPDATE workflow_runs SET data=?,status=? WHERE id=?").run(
      JSON.stringify(replay),
      "queued",
      run.id,
    );
    await workflows.tick();
    assert.equal(
      (await owner.req("state")).data.tasks.length,
      after.tasks.length,
    );
    assert.equal(
      (await owner.req(`workflow-runs/${run.id}`)).data.status,
      "completed",
    );

    await owner.req("admin/users", {
      email: "viewer@workflow.test",
      password: "Viewer workflow test passphrase",
      role: "viewer",
    });
    await owner.req("admin/users", {
      email: "editor@workflow.test",
      password: "Editor workflow test passphrase",
      role: "editor",
    });
    const users = (await owner.req("admin/users")).data,
      vid = users.find((x) => x.role === "viewer").id,
      eid = users.find((x) => x.role === "editor").id;
    await owner.req("admin/access", {
      userId: vid,
      matterId: mid,
      allowed: true,
    });
    await viewer.req("auth/login", {
      email: "viewer@workflow.test",
      password: "Viewer workflow test passphrase",
    });
    assert.equal(
      (await viewer.req(`workflows/${template.id}/runs`, { matterId: mid }))
        .status,
      403,
    );
    await editor.req("auth/login", {
      email: "editor@workflow.test",
      password: "Editor workflow test passphrase",
    });
    assert.equal((await editor.req(`workflow-runs/${run.id}`)).status, 404);
    await owner.req("admin/access", {
      userId: eid,
      matterId: mid,
      allowed: true,
    });
    const revokeRun = (
      await editor.req(`workflows/${template.id}/runs`, { matterId: mid })
    ).data;
    await owner.req("admin/access", {
      userId: eid,
      matterId: mid,
      allowed: false,
    });
    await workflows.tick();
    assert.equal(
      db
        .prepare("SELECT status FROM workflow_runs WHERE id=?")
        .get(revokeRun.id).status,
      "failed",
    );
    await owner.req("admin/access", {
      userId: eid,
      matterId: mid,
      allowed: true,
    });
    let retryState = (await owner.req(`workflow-runs/${revokeRun.id}`)).data;
    assert.equal(
      (
        await owner.req(`workflow-runs/${revokeRun.id}/decision`, {
          revision: retryState.revision,
          action: "retry",
        })
      ).status,
      200,
    );
    await workflows.tick();
    await workflows.tick();
    retryState = (await owner.req(`workflow-runs/${revokeRun.id}`)).data;
    assert.equal(retryState.status, "waiting_approval");
    assert.equal(
      (
        await owner.req(`workflow-runs/${revokeRun.id}/decision`, {
          revision: retryState.revision,
          action: "reject",
          note: "Do not deliver",
        })
      ).data.status,
      "cancelled",
    );
    await owner.req("admin/access", {
      userId: eid,
      matterId: mid,
      allowed: false,
    });
    const intake = (
      await owner.req("intake", {
        matterId: mid,
        title: "Review supplier agreement",
        description: "Governing law and liability",
        priority: "high",
      })
    ).data;
    assert.equal(intake.status, "new");
    assert.equal(
      (
        await owner.req(
          `intake/${intake.id}`,
          { revision: intake.revision, status: "completed" },
          "PATCH",
        )
      ).status,
      400,
    );
    const triage = await owner.req(
      `intake/${intake.id}`,
      { revision: intake.revision, status: "triaged", assigneeId: eid },
      "PATCH",
    );
    assert.equal(triage.status, 400);
    const monitor = (
      await owner.req("monitors", {
        matterId: mid,
        name: "Assignment watch",
        query: "assignment",
      })
    ).data;
    assert.ok(monitor.id);
    const upload = new FormData();
    upload.set("matterId", mid);
    upload.append(
      "files",
      new Blob(["Assignment requires prior written consent of both parties."]),
      "New terms.txt",
    );
    await owner.req("documents", upload);
    const scan = await owner.req(`monitors/${monitor.id}/scan`, {});
    assert.equal(scan.status, 200);
    assert.equal(scan.data.created, 1);
    assert.equal(
      (await owner.req(`monitors/${monitor.id}/scan`, {})).data.created,
      0,
    );
    const alerts = (await owner.req("operations")).data.alerts;
    assert.equal(alerts.length, 1);
    const alert = alerts[0];
    const task = await owner.req(
      `monitor-alerts/${alert.id}`,
      { action: "task" },
      "PATCH",
    );
    assert.equal(task.status, 200);
    const taskAgain = await owner.req(
      `monitor-alerts/${alert.id}`,
      { action: "task" },
      "PATCH",
    );
    assert.equal(taskAgain.data.taskId, task.data.taskId);
    const skill = state.skills[0];
    const update = await owner.req(
      `skills/${skill.id}`,
      {
        version: 1,
        name: skill.name,
        category: skill.category,
        instructions: "Use exact source quotations.",
      },
      "PATCH",
    );
    assert.equal(update.status, 200);
    assert.equal(update.data.version, 2);
    assert.equal(
      (await owner.req(`skills/${skill.id}/versions`)).data.length,
      2,
    );
  } finally {
    await workflows.close();
    await jobs.close();
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
});
