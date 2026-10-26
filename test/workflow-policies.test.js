const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.COUNSEL_DB = ":memory:";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "counsel-policy-"),
);
process.env.AI_PROVIDER = "evidence";
// Advance the workflow runner explicitly so an access change cannot race its timer.
const nativeInterval = global.setInterval;
global.setInterval = (fn, delay, ...args) => {
  const timer = nativeInterval(fn, delay, ...args);
  if (delay === 300) clearInterval(timer);
  return timer;
};
const { app, db, jobs, workflows } = require("../server");
global.setInterval = nativeInterval;

test("independent approval quorum is frozen, distinct and revalidated before side effects", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  function client() {
    return {
      cookie: "",
      csrf: "",
      async req(p, b, method = b ? "POST" : "GET") {
        const response = await fetch(base + p, {
          method,
          headers: {
            Cookie: this.cookie,
            "X-CSRF-Token": this.csrf,
            "Content-Type": "application/json",
          },
          body: b ? JSON.stringify(b) : undefined,
        });
        if (response.headers.get("set-cookie"))
          this.cookie = response.headers.get("set-cookie").split(";")[0];
        const data = await response.json();
        if (data.csrf) this.csrf = data.csrf;
        return { status: response.status, data };
      },
    };
  }
  const owner = client(),
    a = client(),
    b = client(),
    d = client(),
    viewer = client();
  let matterId, ids, template, run, initialTaskCount;
  const definition = {
    name: "Independent partner gate",
    description: "Two current reviewers before follow-up",
    steps: [
      {
        kind: "approval",
        name: "Independent review",
        approvalPolicy: { independent: true, requiredApprovals: 2 },
      },
      {
        kind: "task",
        name: "Approved follow-up",
        prompt: "Confirm the approved memorandum",
      },
    ],
  };
  const access = (userId, allowed) =>
    owner.req("admin/access", { userId, matterId, allowed });
  const current = async () => (await owner.req(`workflow-runs/${run.id}`)).data;
  const decide = (client, revision, action = "approve") =>
    client.req(`workflow-runs/${run.id}/decision`, {
      revision,
      action,
      note: "Inspected the supporting evidence",
    });
  try {
    assert.equal(
      (
        await owner.req("auth/setup", {
          token: fs.readFileSync(
            path.join(process.env.DATA_DIR, "bootstrap-token"),
            "utf8",
          ),
          email: "owner@policy.test",
          password: "Owner policy test passphrase",
          workspace: "Policy verification",
        })
      ).status,
      200,
    );
    const initial = (await owner.req("state")).data;
    matterId = initial.matters[0].id;
    initialTaskCount = initial.tasks.length;
    for (const [email, c, role] of [
      ["a", a, "editor"],
      ["b", b, "editor"],
      ["d", d, "editor"],
      ["viewer", viewer, "viewer"],
    ]) {
      assert.equal(
        (
          await owner.req("admin/users", {
            email: `${email}@policy.test`,
            password: "Member policy test passphrase",
            role,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await c.req("auth/login", {
            email: `${email}@policy.test`,
            password: "Member policy test passphrase",
          })
        ).status,
        200,
      );
    }
    ids = Object.fromEntries(
      (await owner.req("admin/users")).data.map((u) => [
        u.email.split("@")[0],
        u.id,
      ]),
    );
    for (const id of Object.values(ids))
      if (id !== ids.owner) await access(id, true);

    await t.test(
      "approval policy validates, and launch freezes the original policy",
      async () => {
        assert.equal(
          (
            await owner.req("workflows", {
              ...definition,
              steps: [
                {
                  kind: "approval",
                  name: "Bad quorum",
                  approvalPolicy: { requiredApprovals: 3 },
                },
              ],
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await owner.req("workflows", {
              ...definition,
              steps: [
                {
                  kind: "task",
                  name: "Invalid policy placement",
                  approvalPolicy: { independent: true },
                },
              ],
            })
          ).status,
          400,
        );
        const created = await owner.req("workflows", definition);
        assert.equal(created.status, 200);
        template = created.data;
        run = (
          await owner.req(`workflows/${template.id}/runs`, {
            matterId,
            documentIds: [],
          })
        ).data;
        assert.equal(run.initiatorId, ids.owner);
        assert.deepEqual(
          run.steps[0].approvalPolicy,
          definition.steps[0].approvalPolicy,
        );
        assert.equal(
          (
            await owner.req(
              `workflows/${template.id}`,
              {
                ...definition,
                version: template.version,
                steps: [
                  {
                    ...definition.steps[0],
                    approvalPolicy: {
                      independent: false,
                      requiredApprovals: 1,
                    },
                  },
                  definition.steps[1],
                ],
              },
              "PATCH",
            )
          ).status,
          200,
        );
        await workflows.tick();
        const waiting = await current();
        assert.equal(waiting.status, "waiting_approval");
        assert.equal(waiting.approvalState.requiredApprovals, 2);
        assert.equal(waiting.approvalState.validApprovals, 0);
        assert.equal(waiting.approvalState.independent, true);
        assert.equal(waiting.approvalState.canApprove, false);
      },
    );

    await t.test(
      "initiator and read-only accounts cannot sign an independent gate",
      async () => {
        const waiting = await current();
        assert.equal((await decide(owner, waiting.revision)).status, 403);
        assert.equal(
          (await decide(owner, waiting.revision, "reject")).status,
          403,
        );
        assert.equal((await decide(viewer, waiting.revision)).status, 403);
        assert.equal((await current()).outputs.length, 0);
      },
    );

    await t.test(
      "one distinct vote remains pending; duplicate and stale votes fail",
      async () => {
        const waiting = await current();
        const first = await decide(a, waiting.revision);
        assert.equal(first.status, 200);
        assert.equal(first.data.status, "waiting_approval");
        assert.equal(first.data.approvalState.validApprovals, 1);
        assert.equal(first.data.approvalState.pendingApprovals, 1);
        assert.equal(first.data.outputs[0].actorId, ids.a);
        assert.equal((await decide(a, first.data.revision)).status, 409);
        assert.equal((await decide(b, waiting.revision)).status, 409);
        assert.equal(
          (await owner.req("state")).data.tasks.length,
          initialTaskCount,
        );
      },
    );

    await t.test(
      "revoking an earlier reviewer's matter grant removes that vote from quorum",
      async () => {
        await access(ids.a, false);
        let waiting = await current();
        assert.equal(waiting.approvalState.validApprovals, 0);
        assert.equal(waiting.approvalState.decisions[0].valid, false);
        assert.equal((await decide(a, waiting.revision)).status, 404);
        const second = await decide(b, waiting.revision);
        assert.equal(second.status, 200);
        assert.equal(second.data.status, "waiting_approval");
        assert.equal(second.data.approvalState.validApprovals, 1);
        assert.equal(second.data.outputs.length, 2);
        const final = await decide(d, second.data.revision);
        assert.equal(final.status, 200);
        assert.equal(final.data.status, "queued");
        assert.equal(final.data.approvalStates[0].validApprovals, 2);
      },
    );

    await t.test(
      "revoked approvals block the next side effect and retry cannot bypass them",
      async () => {
        await access(ids.b, false);
        await workflows.tick();
        let failed = await current();
        assert.equal(failed.status, "failed");
        assert.match(failed.error, /approval/i);
        assert.equal(
          (await owner.req("state")).data.tasks.length,
          initialTaskCount,
        );
        assert.equal(
          (await decide(owner, failed.revision, "retry")).status,
          200,
        );
        await workflows.tick();
        failed = await current();
        assert.equal(failed.status, "failed");
        assert.equal(
          (await owner.req("state")).data.tasks.length,
          initialTaskCount,
        );
        await access(ids.b, true);
        assert.equal(
          (await decide(owner, failed.revision, "retry")).status,
          200,
        );
        await workflows.tick();
        assert.equal((await current()).status, "completed");
        assert.equal(
          (await owner.req("state")).data.tasks.length,
          initialTaskCount + 1,
        );
        await workflows.tick();
        assert.equal(
          (await owner.req("state")).data.tasks.length,
          initialTaskCount + 1,
        );
      },
    );

    await t.test(
      "a rejection cancels a partially approved run without a later side effect",
      async () => {
        const created = (await owner.req("workflows", definition)).data;
        run = (
          await owner.req(`workflows/${created.id}/runs`, {
            matterId,
            documentIds: [],
          })
        ).data;
        await workflows.tick();
        const waiting = await current();
        const first = await decide(b, waiting.revision);
        assert.equal(first.data.status, "waiting_approval");
        const rejected = await decide(d, first.data.revision, "reject");
        assert.equal(rejected.data.status, "cancelled");
        assert.equal(rejected.data.outputs.at(-1).decision, "reject");
        await workflows.tick();
        assert.equal(
          (await owner.req("state")).data.tasks.length,
          initialTaskCount + 1,
        );
        assert.equal((await decide(b, rejected.data.revision)).status, 409);
      },
    );
  } finally {
    await workflows.close();
    await jobs.close();
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
});
