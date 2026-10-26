const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { WebSocket } = require("ws");
process.env.COUNSEL_DB = ":memory:";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "counsel-portal-"),
);
process.env.AI_PROVIDER = "evidence";
const {
  app,
  db,
  jobs,
  workflows,
  createServer,
  collaboration,
} = require("../server");

test("client publications are explicit snapshots and guests cannot enter the internal workspace", async (t) => {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  function client() {
    return {
      cookie: "",
      csrf: "",
      async req(p, body, method = body === undefined ? "GET" : "POST") {
        const response = await fetch(origin + "/api/" + p, {
          method,
          headers: {
            Cookie: this.cookie,
            "X-CSRF-Token": this.csrf,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (response.headers.get("set-cookie"))
          this.cookie = response.headers.get("set-cookie").split(";")[0];
        const data =
          method === "HEAD"
            ? null
            : response.headers.get("content-type")?.includes("application/json")
              ? await response.json()
              : await response.text();
        if (data?.csrf) this.csrf = data.csrf;
        return { status: response.status, data };
      },
    };
  }
  const owner = client(),
    guest = client(),
    other = client(),
    viewer = client(),
    editor = client();
  let matter,
    source,
    documentPublication,
    textPublication,
    guestId,
    otherId,
    hidden;
  const passphrase = "Portal synthetic client password";
  async function member(email, role, session) {
    assert.equal(
      (await owner.req("admin/users", { email, role, password: passphrase }))
        .status,
      200,
    );
    const users = (await owner.req("admin/users")).data;
    const id = users.find((u) => u.email === email).id;
    assert.equal(
      (
        await owner.req("admin/access", {
          userId: id,
          matterId: matter.id,
          allowed: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (await session.req("auth/login", { email, password: passphrase })).status,
      200,
    );
    return id;
  }
  try {
    assert.equal(
      (
        await owner.req("auth/setup", {
          token: fs.readFileSync(
            path.join(process.env.DATA_DIR, "bootstrap-token"),
            "utf8",
          ),
          email: "owner@portal.test",
          password: passphrase,
          workspace: "Portal verification",
        })
      ).status,
      200,
    );
    const initial = (await owner.req("state")).data;
    matter = initial.matters[0];
    source = initial.documents[0];
    hidden = (await owner.req("matters", { name: "Internal unrelated matter" }))
      .data;
    guestId = await member("client@portal.test", "guest", guest);
    otherId = await member("other-client@portal.test", "guest", other);
    await member("viewer@portal.test", "viewer", viewer);
    await member("editor@portal.test", "editor", editor);
    const publish = {
      matterId: matter.id,
      kind: "document",
      documentId: source.id,
      title: "Approved NDA",
      recipientIds: [guestId],
      confirmedReviewed: true,
    };
    await t.test(
      "guest accounts fail closed for every internal API family, including future routes",
      async () => {
        for (const route of [
          "state",
          `documents/${source.id}`,
          "matters",
          "reviews",
          "drafts",
          "workflows",
          "intake",
          "monitors",
          "connectors",
          "agent-tokens",
          "admin/users",
          "admin/access",
          "admin/audit",
          "portal/manage",
          `portal/recipients?matterId=${matter.id}`,
          "future-internal-feature",
        ]) {
          const result = await guest.req(route);
          assert.equal(result.status, 403, route);
          assert.equal(result.data.error, "Client portal access only.", route);
        }
        assert.equal((await guest.req("state", undefined, "HEAD")).status, 403);
        assert.equal((await guest.req("portal/manage", publish)).status, 403);
        assert.equal(
          (
            await guest.req("agent-tokens", {
              name: "No access",
              matterIds: [matter.id],
            })
          ).status,
          403,
        );
        assert.equal((await guest.req("auth/me")).data.user.role, "guest");
        assert.deepEqual((await guest.req("portal/items")).data.items, []);
      },
    );
    await t.test(
      "publication requires staff permission, reviewed confirmation and explicit valid recipients",
      async () => {
        assert.equal((await viewer.req("portal/manage", publish)).status, 403);
        assert.equal(
          (
            await owner.req("portal/manage", {
              ...publish,
              confirmedReviewed: false,
            })
          ).status,
          400,
        );
        assert.equal(
          (await owner.req("portal/manage", { ...publish, recipientIds: [] }))
            .status,
          400,
        );
        assert.equal(
          (
            await owner.req("portal/manage", {
              ...publish,
              recipientIds: [guestId, guestId],
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await owner.req("portal/manage", {
              ...publish,
              recipientIds: [randomUUID()],
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await owner.req("portal/manage", {
              ...publish,
              matterId: hidden.id,
            })
          ).status,
          404,
        );
        assert.equal(
          (await editor.req("portal/recipients?matterId=" + hidden.id)).status,
          404,
        );
        const created = await editor.req("portal/manage", publish);
        assert.equal(created.status, 200);
        documentPublication = created.data;
        const recipients = (
          await editor.req("portal/recipients?matterId=" + matter.id)
        ).data;
        assert.deepEqual(
          recipients.map((u) => u.id).sort(),
          [guestId, otherId].sort(),
        );
        const row = db
          .prepare(
            "SELECT content,source_hash FROM portal_publications WHERE id=?",
          )
          .get(documentPublication.id);
        assert.equal(row.content, source.text);
        assert.equal(
          row.source_hash,
          createHash("sha256").update(source.text).digest("hex"),
        );
      },
    );
    await t.test(
      "only named recipients see a publication, even when another guest has the same matter grant",
      async () => {
        const list = await guest.req("portal/items");
        assert.equal(list.status, 200);
        assert.deepEqual(
          list.data.items.map((p) => p.id),
          [documentPublication.id],
        );
        assert.equal(list.data.items[0].content, undefined);
        assert.equal(list.data.items[0].publisher, undefined);
        assert.equal(list.data.items[0].recipientIds, undefined);
        const item = await guest.req(`portal/items/${documentPublication.id}`);
        assert.equal(item.status, 200);
        assert.equal(item.data.content, source.text);
        assert.equal(item.data.snapshot, true);
        assert.deepEqual((await other.req("portal/items")).data.items, []);
        assert.equal(
          (await other.req(`portal/items/${documentPublication.id}`)).status,
          404,
        );
        assert.equal(
          (await guest.req(`portal/items/${randomUUID()}`)).status,
          404,
        );
      },
    );
    await t.test(
      "reviewed text is explicitly published; arbitrary internal draft references are rejected",
      async () => {
        const text = {
          matterId: matter.id,
          title: "Reviewed conclusion",
          kind: "reviewed_text",
          content:
            "Client-approved summary <script>must remain plain text</script>",
          recipientIds: [guestId],
          confirmedReviewed: true,
        };
        assert.equal(
          (await owner.req("portal/manage", { ...text, draftId: randomUUID() }))
            .status,
          400,
        );
        assert.equal(
          (await owner.req("portal/manage", { ...text, documentId: source.id }))
            .status,
          400,
        );
        const result = await owner.req("portal/manage", text);
        assert.equal(result.status, 200);
        textPublication = result.data;
        assert.equal(
          (await guest.req(`portal/items/${textPublication.id}`)).data.content,
          text.content,
        );
        assert.equal(
          (await other.req(`portal/items/${textPublication.id}`)).status,
          404,
        );
        assert.equal(
          (await owner.req(`portal/manage/${textPublication.id}/revoke`, {}))
            .status,
          200,
        );
        assert.equal(
          (await guest.req(`portal/items/${textPublication.id}`)).status,
          404,
        );
        assert.deepEqual(
          (await guest.req("portal/items")).data.items.map((p) => p.id),
          [documentPublication.id],
        );
        assert.ok(
          (await owner.req("admin/audit")).data.some(
            (a) =>
              a.action === "portal.revoked" &&
              a.resource === textPublication.id,
          ),
        );
      },
    );
    await t.test(
      "publication identifiers never cross workspace boundaries",
      async () => {
        const foreignId = randomUUID();
        db.prepare(
          "INSERT INTO portal_publications VALUES(?,?,?,?,?,?,?,?,?,?,?,0)",
        ).run(
          foreignId,
          randomUUID(),
          matter.id,
          "Foreign client secret",
          "reviewed_text",
          null,
          null,
          "Foreign workspace content must remain hidden",
          JSON.stringify([guestId]),
          new Date().toISOString(),
          randomUUID(),
        );
        assert.equal(
          (await guest.req(`portal/items/${foreignId}`)).status,
          404,
        );
        assert.ok(
          !(await guest.req("portal/items")).data.items.some(
            (p) => p.id === foreignId,
          ),
        );
        assert.ok(
          !(await owner.req("portal/manage")).data.some(
            (p) => p.id === foreignId,
          ),
        );
        assert.equal(
          (await owner.req(`portal/manage/${foreignId}/revoke`, {})).status,
          404,
        );
      },
    );
    await t.test(
      "matter revocation and disabled accounts stop publication reads immediately",
      async () => {
        await owner.req("admin/access", {
          userId: guestId,
          matterId: matter.id,
          allowed: false,
        });
        assert.deepEqual((await guest.req("portal/items")).data.items, []);
        assert.equal(
          (await guest.req(`portal/items/${documentPublication.id}`)).status,
          404,
        );
        await owner.req("admin/access", {
          userId: guestId,
          matterId: matter.id,
          allowed: true,
        });
        assert.equal(
          (await guest.req(`portal/items/${documentPublication.id}`)).status,
          200,
        );
        assert.equal(
          (await guest.req(`portal/items/${textPublication.id}`)).status,
          404,
        );
        await owner.req(`admin/users/${guestId}`, { disabled: true }, "PATCH");
        assert.equal((await guest.req("portal/items")).status, 401);
        await owner.req(`admin/users/${guestId}`, { disabled: false }, "PATCH");
        assert.equal((await guest.req("portal/items")).status, 401);
        assert.equal(
          (
            await guest.req("auth/login", {
              email: "client@portal.test",
              password: passphrase,
            })
          ).status,
          200,
        );
      },
    );
    await t.test(
      "guests cannot open collaboration sockets or use a forged legacy MCP key",
      async () => {
        const draft = (
          await owner.req("drafts", {
            matterId: matter.id,
            title: "Internal work",
            prompt: "Governing law",
          })
        ).data;
        await new Promise((resolve, reject) => {
          const ws = new WebSocket(
            origin.replace("http:", "ws:") + "/collaboration?draft=" + draft.id,
            { headers: { Cookie: guest.cookie, Origin: origin } },
          );
          const timer = setTimeout(() => {
            ws.terminate();
            reject(Error("Guest socket was not rejected"));
          }, 5000);
          ws.on("open", () => {
            clearTimeout(timer);
            ws.terminate();
            reject(
              Error("Guest received an internal collaboration connection"),
            );
          });
          ws.on("error", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        const key = "counsel_" + "a".repeat(64),
          wid = db
            .prepare("SELECT workspace_id FROM users WHERE id=?")
            .get(guestId).workspace_id;
        db.prepare("INSERT INTO agent_tokens VALUES(?,?,?,?,?,?,?,?,0,?)").run(
          randomUUID(),
          wid,
          guestId,
          "Forged legacy guest token",
          createHash("sha256").update(key).digest("hex"),
          "read",
          JSON.stringify([matter.id]),
          Date.now() + 60000,
          new Date().toISOString(),
        );
        const response = await fetch(origin + "/agent/v1/list_matters", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        assert.equal(response.status, 401);
      },
    );
    await t.test(
      "source mutation or deletion hides old publications instead of exposing stale content",
      async () => {
        const workspace = db.prepare("SELECT id,value FROM workspaces").get();
        const value = JSON.parse(workspace.value);
        value.documents.find((d) => d.id === source.id).text +=
          "\n\nChanged after publication.";
        db.prepare("UPDATE workspaces SET value=? WHERE id=?").run(
          JSON.stringify(value),
          workspace.id,
        );
        assert.equal(
          (await guest.req(`portal/items/${documentPublication.id}`)).status,
          404,
        );
        assert.deepEqual((await guest.req("portal/items")).data.items, []);
        assert.equal(
          (await owner.req("portal/manage")).data.find(
            (p) => p.id === documentPublication.id,
          ).sourceAvailable,
          false,
        );
        value.documents.find((d) => d.id === source.id).text = source.text;
        db.prepare("UPDATE workspaces SET value=? WHERE id=?").run(
          JSON.stringify(value),
          workspace.id,
        );
        assert.equal(
          (await guest.req(`portal/items/${documentPublication.id}`)).status,
          200,
        );
        await owner.req(`documents/${source.id}`, undefined, "DELETE");
        assert.equal(
          (await guest.req(`portal/items/${documentPublication.id}`)).status,
          404,
        );
        assert.deepEqual((await guest.req("portal/items")).data.items, []);
        const persisted = db
          .prepare("SELECT content FROM portal_publications WHERE id=?")
          .get(documentPublication.id);
        assert.equal(persisted.content, source.text);
      },
    );
    await t.test(
      "guests retain only their own password and logout operations",
      async () => {
        const result = await guest.req("auth/password", {
          currentPassword: passphrase,
          password: "Changed portal guest test password",
        });
        assert.equal(result.status, 200);
        assert.equal((await guest.req("portal/items")).status, 200);
        assert.equal((await guest.req("auth/logout", {})).status, 200);
        assert.equal((await guest.req("portal/items")).status, 401);
      },
    );
  } finally {
    await workflows.close();
    await jobs.close();
    collaboration.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
});
