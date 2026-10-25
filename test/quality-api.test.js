const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.COUNSEL_DB = ":memory:";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "counsel-quality-"),
);
process.env.AI_PROVIDER = "evidence";
const { app, db, jobs, workflows } = require("../server");

test("comparison and evidence workflows preserve selected sources and recheck current access", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  function client() {
    return {
      cookie: "",
      csrf: "",
      async req(p, body, method = body ? "POST" : "GET") {
        const r = await fetch(origin + "/api/" + p, {
          method,
          headers: {
            Cookie: this.cookie,
            "X-CSRF-Token": this.csrf,
            ...(body instanceof FormData
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body:
            body instanceof FormData
              ? body
              : body
                ? JSON.stringify(body)
                : undefined,
        });
        if (r.headers.get("set-cookie"))
          this.cookie = r.headers.get("set-cookie").split(";")[0];
        const data = r.headers.get("content-type")?.includes("application/json")
          ? await r.json()
          : await r.text();
        if (data.csrf) this.csrf = data.csrf;
        return { status: r.status, data, headers: r.headers };
      },
    };
  }
  const owner = client(),
    viewer = client();
  let matter,
    hidden,
    first,
    second,
    foreign,
    comparison,
    message,
    draft,
    review;
  async function upload(matterId, name, text) {
    const form = new FormData();
    form.append("matterId", matterId);
    form.append("files", new Blob([text], { type: "text/plain" }), name);
    const r = await owner.req("documents", form);
    assert.equal(r.status, 200);
    assert.ok(r.data[0].id);
    return r.data[0];
  }
  try {
    await owner.req("auth/setup", {
      token: fs.readFileSync(
        path.join(process.env.DATA_DIR, "bootstrap-token"),
        "utf8",
      ),
      email: "owner@quality.test",
      password: "Quality owner passphrase for testing",
      workspace: "Quality test",
    });
    matter = (await owner.req("matters", { name: "Comparison matter" })).data;
    hidden = (await owner.req("matters", { name: "Unrelated matter" })).data;
    first = await upload(
      matter.id,
      "Agreement v1.txt",
      "AGREEMENT\n\n1. Governing law. This agreement is governed by the laws of England and Wales.\n\n2. Liability. Liability is capped at GBP 100,000.",
    );
    second = await upload(
      matter.id,
      "Agreement v2.txt",
      "AGREEMENT\n\n1. Governing law. This agreement is governed by the laws of New York.\n\n2. Liability. Liability is capped at GBP 200,000.",
    );
    foreign = await upload(
      hidden.id,
      "Secret.txt",
      "Secret liability clause for an unrelated matter.",
    );
    const definition = {
      name: "Versions compared",
      matterId: matter.id,
      documentIds: [first.id, second.id],
      questions: ["Governing law", "Liability cap", "Arbitration"],
    };
    await t.test(
      "persisted comparison exposes exact changed passages and explicit no-match results",
      async () => {
        const result = await owner.req("comparisons", definition);
        assert.equal(result.status, 200);
        comparison = result.data;
        assert.deepEqual(
          comparison.rows.map((r) => r.coverage.matched),
          [2, 2, 0],
        );
        assert.ok(
          comparison.rows[1].diff.parts.some(
            (p) => p.kind === "removed" && p.text.includes("100,000"),
          ),
        );
        assert.ok(
          comparison.rows[1].diff.parts.some(
            (p) => p.kind === "added" && p.text.includes("200,000"),
          ),
        );
        assert.equal(comparison.rows[2].diff, null);
        assert.equal(comparison.rows[2].findings[0].status, "no_match");
        assert.match(comparison.notice, /No match does not establish/);
        assert.equal(
          (await owner.req("comparisons")).data.find(
            (r) => r.id === comparison.id,
          ).questionCount,
          3,
        );
        assert.equal(
          JSON.parse(
            db
              .prepare("SELECT data FROM document_comparisons WHERE id=?")
              .get(comparison.id).data,
          ).name,
          definition.name,
        );
        const exported = await owner.req(`comparisons/${comparison.id}/export`);
        assert.equal(exported.status, 200);
        assert.match(
          exported.headers.get("content-disposition"),
          /comparison\.csv/,
        );
        assert.match(exported.data, /GBP 100,000/);
        assert.match(exported.data, /No matching passage found/);
      },
    );
    await t.test(
      "duplicate and foreign source IDs fail before comparison is saved",
      async () => {
        assert.equal(
          (
            await owner.req("comparisons", {
              ...definition,
              documentIds: [first.id, first.id],
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await owner.req("comparisons", {
              ...definition,
              documentIds: [first.id, foreign.id],
            })
          ).status,
          404,
        );
        assert.equal((await owner.req("comparisons")).data.length, 1);
      },
    );
    await t.test(
      "viewers see only granted comparison results and cannot create them",
      async () => {
        await owner.req("admin/users", {
          email: "viewer@quality.test",
          password: "Quality viewer passphrase for testing",
          role: "viewer",
        });
        const member = (await owner.req("admin/users")).data.find(
          (u) => u.email === "viewer@quality.test",
        );
        await viewer.req("auth/login", {
          email: member.email,
          password: "Quality viewer passphrase for testing",
        });
        assert.deepEqual((await viewer.req("comparisons")).data, []);
        assert.equal(
          (await viewer.req(`comparisons/${comparison.id}`)).status,
          404,
        );
        assert.equal(
          (await viewer.req(`comparisons/${comparison.id}/export`)).status,
          404,
        );
        await owner.req("admin/access", {
          userId: member.id,
          matterId: matter.id,
          allowed: true,
        });
        assert.equal(
          (await viewer.req(`comparisons/${comparison.id}`)).status,
          200,
        );
        assert.equal(
          (await viewer.req(`comparisons/${comparison.id}/export`)).status,
          200,
        );
        assert.equal((await viewer.req("comparisons", definition)).status, 403);
        await owner.req("admin/access", {
          userId: member.id,
          matterId: matter.id,
          allowed: false,
        });
        assert.equal(
          (await viewer.req(`comparisons/${comparison.id}`)).status,
          404,
        );
      },
    );
    await t.test(
      "an explicit empty selection never expands into all matter documents",
      async () => {
        const emptyChat = await owner.req("chat", {
          matterId: matter.id,
          query: "Liability cap",
          documentIds: [],
        });
        assert.equal(emptyChat.status, 200);
        assert.equal(emptyChat.data.citations.length, 0);
        assert.equal(emptyChat.data.evidence.status, "no_sources");
        const defaultChat = await owner.req("chat", {
          matterId: matter.id,
          query: "Liability cap",
        });
        assert.ok(defaultChat.data.citations.length > 0);
        const emptyDraft = await owner.req("drafts", {
          matterId: matter.id,
          prompt: "Liability cap",
          documentIds: [],
        });
        assert.equal(emptyDraft.status, 200);
        assert.equal(emptyDraft.data.citations.length, 0);
        const emptyReview = await owner.req("reviews", {
          matterId: matter.id,
          columns: ["Liability cap"],
          documentIds: [],
        });
        assert.equal(emptyReview.status, 200);
        assert.equal(emptyReview.data.cells.length, 0);
        assert.equal(
          (
            await owner.req("chat", {
              matterId: matter.id,
              query: "Liability cap",
              documentIds: [foreign.id],
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await owner.req("drafts", {
              matterId: matter.id,
              prompt: "Liability cap",
              documentIds: [foreign.id],
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await owner.req("reviews", {
              matterId: matter.id,
              columns: ["Liability cap"],
              documentIds: [foreign.id],
            })
          ).status,
          404,
        );
      },
    );
    await t.test(
      "an explicitly selected previous version remains frozen across chat, draft, and review",
      async () => {
        const row = db.prepare("SELECT id,value FROM workspaces").get();
        const state = JSON.parse(row.value);
        state.documents.find((d) => d.id === first.id).supersededBy = second.id;
        db.prepare("UPDATE workspaces SET value=? WHERE id=?").run(
          JSON.stringify(state),
          row.id,
        );
        const current = await owner.req("chat", {
          matterId: matter.id,
          query: "Liability cap",
        });
        assert.ok(current.data.citations.length);
        assert.ok(
          current.data.citations.every((c) => c.documentId !== first.id),
        );
        message = (
          await owner.req("chat", {
            matterId: matter.id,
            query: "Liability cap",
            documentIds: [first.id],
          })
        ).data;
        draft = (
          await owner.req("drafts", {
            matterId: matter.id,
            prompt: "Liability cap",
            documentIds: [first.id],
          })
        ).data;
        review = (
          await owner.req("reviews", {
            matterId: matter.id,
            columns: ["Liability cap"],
            documentIds: [first.id],
          })
        ).data;
        for (const item of [message, draft]) {
          assert.ok(item.citations.length);
          assert.ok(item.citations.every((c) => c.documentId === first.id));
        }
        assert.equal(review.cells.length, 1);
        assert.equal(review.cells[0].documentId, first.id);
        assert.ok(review.cells[0].citations.length);
        const report = (
          await owner.req(
            `reviews/${review.id}/cells/${review.cells[0].id}/evidence`,
          )
        ).data;
        assert.equal(report.checkedOutputText, false);
        assert.ok(report.issues.some((i) => i.code === "source_superseded"));
      },
    );
    await t.test(
      "no evidence skips generation even when an API provider is enabled",
      async () => {
        const nativeFetch = global.fetch;
        let externalCalls = 0;
        global.fetch = (url, ...rest) => {
          if (!String(url).startsWith(origin + "/")) {
            externalCalls++;
            throw Error(
              "External generation must not occur for missing evidence",
            );
          }
          return nativeFetch(url, ...rest);
        };
        process.env.AI_PROVIDER = "openai";
        process.env.OPENAI_API_KEY = "invalid-test-key";
        try {
          const result = await owner.req("chat", {
            matterId: matter.id,
            query: "quuxrandozebraxy absentterm",
          });
          assert.equal(result.status, 200);
          assert.equal(result.data.citations.length, 0);
          assert.equal(result.data.evidence.status, "no_sources");
          assert.equal(externalCalls, 0);
        } finally {
          global.fetch = nativeFetch;
          process.env.AI_PROVIDER = "evidence";
          delete process.env.OPENAI_API_KEY;
        }
      },
    );
    await t.test(
      "saved evidence reports and comparisons detect subsequently removed sources",
      async () => {
        await owner.req(`documents/${first.id}`, undefined, "DELETE");
        for (const p of [
          `messages/${message.id}/evidence`,
          `drafts/${draft.id}/evidence`,
          `reviews/${review.id}/cells/${review.cells[0].id}/evidence`,
        ]) {
          const result = await owner.req(p);
          assert.equal(result.status, 200);
          assert.equal(result.data.status, "needs_review");
          assert.ok(
            result.data.issues.some((i) => i.code === "source_missing"),
          );
          assert.equal((await viewer.req(p)).status, 404);
        }
        const retained = (await owner.req(`comparisons/${comparison.id}`)).data;
        assert.deepEqual(retained.unavailableSources, [first.id]);
        assert.equal(
          retained.rows[1].findings[0].sources[0].documentId,
          first.id,
        );
        assert.match(retained.rows[1].findings[0].sources[0].text, /100,000/);
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
