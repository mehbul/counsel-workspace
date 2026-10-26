const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

process.env.COUNSEL_DB = ":memory:";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "counsel-notifications-"),
);
process.env.AI_PROVIDER = "evidence";
process.env.ALLOW_PRIVATE_WEBHOOKS = "true";

const publication = (number) => ({
  documentNumber: number,
  title: "Synthetic publication " + number,
  publicationDate: "2026-10-20",
  type: "Notice",
  citation: "91 FR 1234",
  effectiveOn: "2026-11-01",
  abstract: "Informational publication summary.",
  agencies: ["Synthetic agency"],
  url: `https://www.federalregister.gov/documents/2026/10/20/${number}`,
});
let feed = [publication("2026-20001")];
const legalSources = require("../legal-sources");
legalSources.searchFederalRegister = async () => ({
  provider: "federal-register",
  jurisdiction: "US federal",
  results: feed,
  nextPage: null,
  partial: false,
});

const { app, db, notifications, workflows, research } = require("../server");
const { privateIp, validateWebhookUrl } = require("../notifications");

test("notification channels sign, retry and retain deliveries across workflow and monitor events", async () => {
  const received = [];
  let rejectStatus = 400;
  const receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.url === "/reject" && rejectStatus) {
        res.writeHead(rejectStatus, { "Content-Type": "text/plain" });
        return res.end("rejected");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(0, "127.0.0.1", resolve);
  });
  const hookBase = `http://127.0.0.1:${receiver.address().port}`;
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
  });
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
            ...(b instanceof FormData
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body:
            b instanceof FormData
              ? b
              : b === undefined
                ? undefined
                : JSON.stringify(b),
        });
        if (response.headers.get("set-cookie"))
          this.cookie = response.headers.get("set-cookie").split(";")[0];
        const data = await response.json();
        if (data.csrf) this.csrf = data.csrf;
        return { status: response.status, data, headers: response.headers };
      },
    };
  }
  const owner = client(),
    editor = client(),
    viewer = client();
  try {
    await owner.req("auth/setup", {
      token: fs.readFileSync(
        path.join(process.env.DATA_DIR, "bootstrap-token"),
        "utf8",
      ),
      email: "owner@notify.test",
      password: "Owner notification test passphrase",
      workspace: "Notification test",
    });
    for (const [role, email] of [
      ["editor", "editor@notify.test"],
      ["viewer", "viewer@notify.test"],
    ])
      assert.equal(
        (
          await owner.req("admin/users", {
            email,
            password: `${role} notification passphrase`,
            role,
          })
        ).status,
        200,
      );
    assert.equal(
      (
        await editor.req("auth/login", {
          email: "editor@notify.test",
          password: "editor notification passphrase",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await viewer.req("auth/login", {
          email: "viewer@notify.test",
          password: "viewer notification passphrase",
        })
      ).status,
      200,
    );
    const state = (await owner.req("state")).data,
      matterId = state.matters[0].id;

    assert.equal(privateIp("127.0.0.1"), true);
    assert.equal(privateIp("169.254.169.254"), true);
    assert.equal(privateIp("::1"), true);
    assert.equal(privateIp("::ffff:127.0.0.1"), true);
    assert.equal(privateIp("8.8.8.8"), false);
    assert.throws(() => validateWebhookUrl("http://example.com/hook"), /HTTPS/);
    assert.throws(
      () => validateWebhookUrl("https://user:pass@example.com/hook"),
      /credentials/,
    );
    assert.throws(
      () => validateWebhookUrl("http://127.0.0.1:3000/hook"),
      /private|HTTPS/,
    );
    assert.equal(
      validateWebhookUrl("http://127.0.0.1:3000/hook", {
        allowPrivate: true,
      }).href,
      "http://127.0.0.1:3000/hook",
    );

    assert.equal((await editor.req("notification-channels")).status, 403);
    assert.equal((await viewer.req("notification-channels")).status, 403);
    assert.equal((await editor.req("notification-deliveries")).status, 403);
    assert.equal(
      (
        await editor.req("notification-channels", {
          name: "Blocked",
          kind: "webhook",
          url: hookBase + "/hook",
        })
      ).status,
      403,
    );

    const secret = "notification-test-secret-0123456789";
    const created = await owner.req("notification-channels", {
      name: "Operations webhook",
      kind: "webhook",
      url: hookBase + "/hook",
      secret,
      events: [
        "workflow.approval_required",
        "workflow.completed",
        "workflow.failed",
        "workflow.cancelled",
        "monitor.alert",
      ],
      enabled: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.secret, secret);
    const stored = db
      .prepare("SELECT url,secret FROM notification_channels WHERE id=?")
      .get(created.data.id);
    assert.notEqual(stored.url, hookBase + "/hook");
    assert.notEqual(stored.secret, secret);

    const tested = await owner.req(
      `notification-channels/${created.data.id}/test`,
      {},
    );
    assert.equal(tested.status, 200, JSON.stringify(tested.data));
    assert.equal(tested.data.status, "delivered");
    assert.equal(tested.data.responseStatus, 200);
    const hookRequest = received.find((r) => r.path === "/hook");
    assert.ok(hookRequest);
    assert.equal(hookRequest.headers["x-counsel-event"], "test");
    const timestamp = hookRequest.headers["x-counsel-timestamp"];
    assert.match(timestamp, /^\d+$/);
    assert.equal(
      hookRequest.headers["x-counsel-signature"],
      "v1=" +
        createHmac("sha256", secret)
          .update(`${timestamp}.${hookRequest.body}`)
          .digest("hex"),
    );
    assert.equal(JSON.parse(hookRequest.body).event, "test");

    let receipts = (await owner.req("notification-deliveries")).data;
    assert.ok(receipts.some((d) => d.id === tested.data.id));
    assert.equal(
      receipts.find((d) => d.id === tested.data.id).channelName,
      "Operations webhook",
    );

    const workspaceId = db
      .prepare("SELECT workspace_id FROM users WHERE role='owner' LIMIT 1")
      .get().workspace_id;
    const payload = {
      event: "workflow.completed",
      key: "dedupe:test",
      title: "Deduplicated delivery",
      text: "Only one delivery should be stored.",
    };
    assert.equal(notifications.notify(payload, workspaceId).length, 1);
    assert.equal(notifications.notify(payload, workspaceId).length, 0);
    const beforeDedupe = received.filter((r) => r.path === "/hook").length;
    await notifications.tick();
    assert.equal(
      received.filter((r) => r.path === "/hook").length,
      beforeDedupe + 1,
    );
    await notifications.tick();
    assert.equal(
      received.filter((r) => r.path === "/hook").length,
      beforeDedupe + 1,
    );

    const rejecting = await owner.req("notification-channels", {
      name: "Rejecting webhook",
      kind: "webhook",
      url: hookBase + "/reject",
      events: ["workflow.completed"],
      enabled: true,
    });
    assert.equal(rejecting.status, 201);
    const failed = await owner.req(
      `notification-channels/${rejecting.data.id}/test`,
      {},
    );
    assert.equal(failed.status, 200);
    assert.equal(failed.data.status, "dead", JSON.stringify(failed.data));
    assert.equal(failed.data.attempts, 1);
    assert.equal(failed.data.responseStatus, 400);
    assert.equal(
      (await editor.req(`notification-deliveries/${failed.data.id}/retry`, {}))
        .status,
      403,
    );
    rejectStatus = 0;
    const retried = await owner.req(
      `notification-deliveries/${failed.data.id}/retry`,
      {},
    );
    assert.equal(retried.status, 200);
    assert.equal(retried.data.status, "pending");
    await notifications.tick();
    receipts = (await owner.req("notification-deliveries")).data;
    const delivered = receipts.find((d) => d.id === failed.data.id);
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.attempts, 1);
    assert.equal(delivered.responseStatus, 200);

    const approvalTemplate = await owner.req("workflows", {
      name: "Notification approval",
      description: "Approval notification coverage",
      steps: [{ kind: "approval", name: "Approve" }],
    });
    assert.equal(approvalTemplate.status, 200);
    const approvalRun = await owner.req(
      `workflows/${approvalTemplate.data.id}/runs`,
      { matterId, input: "", documentIds: [] },
    );
    assert.equal(approvalRun.status, 200);
    await workflows.tick();
    let current = (await owner.req(`workflow-runs/${approvalRun.data.id}`))
      .data;
    assert.equal(current.status, "waiting_approval");
    await notifications.tick();
    receipts = (await owner.req("notification-deliveries?limit=100")).data;
    assert.ok(
      receipts.some(
        (d) =>
          d.event === "workflow.approval_required" &&
          d.title.includes("Notification approval"),
      ),
    );
    assert.equal(
      (
        await owner.req(`workflow-runs/${approvalRun.data.id}/decision`, {
          revision: current.revision,
          action: "approve",
        })
      ).status,
      200,
    );
    await notifications.tick();
    receipts = (await owner.req("notification-deliveries?limit=100")).data;
    assert.ok(
      receipts.some(
        (d) =>
          d.event === "workflow.completed" &&
          d.title.includes("Notification approval"),
      ),
    );

    const cancelledRun = await owner.req(
      `workflows/${approvalTemplate.data.id}/runs`,
      { matterId, input: "", documentIds: [] },
    );
    assert.equal(
      (
        await owner.req(`workflow-runs/${cancelledRun.data.id}/decision`, {
          revision: cancelledRun.data.revision,
          action: "cancel",
        })
      ).status,
      200,
    );
    await notifications.tick();
    receipts = (await owner.req("notification-deliveries?limit=100")).data;
    assert.ok(
      receipts.some(
        (d) =>
          d.event === "workflow.cancelled" &&
          d.title.includes("Notification approval"),
      ),
    );

    const failingTemplate = await owner.req("workflows", {
      name: "Notification failure",
      description: "Failure notification coverage",
      steps: [{ kind: "search", name: "Search", prompt: "Summarize" }],
    });
    const documentId = state.documents[0].id;
    const failingRun = await owner.req(
      `workflows/${failingTemplate.data.id}/runs`,
      { matterId, input: "", documentIds: [documentId] },
    );
    assert.equal(failingRun.status, 200);
    assert.equal(
      (await owner.req(`documents/${documentId}`, undefined, "DELETE")).status,
      200,
    );
    await workflows.tick();
    assert.equal(
      (await owner.req(`workflow-runs/${failingRun.data.id}`)).data.status,
      "failed",
    );
    await notifications.tick();
    receipts = (await owner.req("notification-deliveries?limit=100")).data;
    assert.ok(
      receipts.some(
        (d) =>
          d.event === "workflow.failed" &&
          d.title.includes("Notification failure"),
      ),
    );

    const watch = await owner.req("research/watches", {
      matterId,
      name: "Notification publication watch",
      query: "privacy",
      from: "2026-10-01",
      intervalMinutes: 60,
    });
    assert.equal(watch.status, 200, JSON.stringify(watch.data));
    feed = [publication("2026-20002"), publication("2026-20001")];
    const scan = await owner.req(`research/watches/${watch.data.id}/scan`, {});
    assert.equal(scan.status, 200, JSON.stringify(scan.data));
    assert.equal(scan.data.alerts.length, 1);
    await notifications.tick();
    receipts = (await owner.req("notification-deliveries?limit=100")).data;
    assert.ok(
      receipts.some(
        (d) =>
          d.event === "monitor.alert" && d.text.includes("1 new publication"),
      ),
    );

    assert.equal(
      (
        await owner.req(
          `notification-channels/${rejecting.data.id}`,
          undefined,
          "DELETE",
        )
      ).status,
      200,
    );
    receipts = (await owner.req("notification-deliveries?limit=100")).data;
    assert.equal(
      receipts.find((d) => d.id === failed.data.id).channelName,
      "Deleted channel",
    );
  } finally {
    await notifications.close();
    await workflows.close();
    await research.close();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => receiver.close(resolve));
  }
});
