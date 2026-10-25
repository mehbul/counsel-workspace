const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
process.env.COUNSEL_DB = ":memory:";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "counsel-mcp-"));
process.env.AI_PROVIDER = "openai";
process.env.OPENAI_API_KEY = "not-a-real-key-must-never-be-called";
const { app, db, jobs, workflows } = require("../server");
test("MCP connects over stdio; scoped evidence and host-written drafts require no model API; retries and revocation are enforced", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/client/stdio");
  let client;
  let cookie = "",
    csrf = "";
  async function api(p, b, method = b ? "POST" : "GET") {
    const r = await fetch(origin + "/api/" + p, {
      method,
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: b ? JSON.stringify(b) : undefined,
    });
    if (r.headers.get("set-cookie"))
      cookie = r.headers.get("set-cookie").split(";")[0];
    const data = await r.json();
    if (data.csrf) csrf = data.csrf;
    return { status: r.status, data };
  }
  const direct = async (key, op, b) => {
    const r = await fetch(origin + "/agent/v1/" + op, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(b),
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    await api("auth/setup", {
      token: fs.readFileSync(
        path.join(process.env.DATA_DIR, "bootstrap-token"),
        "utf8",
      ),
      email: "owner@mcp.test",
      password: "MCP test owner passphrase long",
      workspace: "MCP test",
    });
    const state = (await api("state")).data,
      mid = state.matters[0].id,
      doc = state.documents[0];
    assert.ok(!JSON.stringify(state).includes(process.env.OPENAI_API_KEY));
    const hidden = (await api("matters", { name: "Not granted to assistant" }))
      .data;
    const readKey = (
      await api("agent-tokens", {
        name: "Read only",
        matterIds: [mid],
        mode: "read",
      })
    ).data;
    assert.ok(readKey.token);
    assert.ok(
      !JSON.stringify((await api("agent-tokens")).data).includes(readKey.token),
    );
    assert.ok(
      !db
        .prepare("SELECT hash FROM agent_tokens WHERE id=?")
        .get(readKey.id)
        .hash.includes(readKey.token),
    );
    assert.equal(
      (await direct(readKey.token, "list_documents", { matterId: hidden.id }))
        .status,
      404,
    );
    assert.equal(
      (
        await direct(readKey.token, "import_text", {
          matterId: mid,
          requestId: randomUUID(),
          name: "denied",
          text: "denied",
        })
      ).status,
      403,
    );
    const listed = await direct(readKey.token, "list_matters", {});
    assert.equal(listed.data.total, 1);
    assert.equal(listed.data.items[0].id, mid);
    const writeKey = (
      await api("agent-tokens", {
        name: "Writer",
        matterIds: [mid],
        mode: "write",
      })
    ).data;
    const connection = path.join(process.env.DATA_DIR, "connection.json");
    fs.writeFileSync(
      connection,
      JSON.stringify({ url: origin, token: writeKey.token }),
    );
    client = new Client({ name: "counsel-integration-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("mcp/server.mjs"), "--connection-file", connection],
      stderr: "pipe",
    });
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.ok(tools.length >= 10);
    assert.ok(
      tools.find((t) => t.name === "counsel_search").annotations.readOnlyHint,
    );
    assert.equal(
      tools.find((t) => t.name === "counsel_create_draft").annotations
        .readOnlyHint,
      false,
    );
    const call = async (name, args = {}) => {
      const result = await client.callTool({
        name: "counsel_" + name,
        arguments: args,
      });
      return {
        result,
        data: result.structuredContent || JSON.parse(result.content[0].text),
      };
    };
    const session = await call("session");
    assert.equal(session.data.modelCalls, false);
    const source = await call("read_document", {
      matterId: mid,
      documentId: doc.id,
      startParagraph: 1,
      limit: 2,
    });
    assert.equal(source.data.paragraphs[0].paragraph, 1);
    const searched = await call("search", {
      matterId: mid,
      query: "governing law",
      documentIds: [doc.id],
    });
    assert.ok(searched.data.citations.length);
    const evidence = searched.data.citations[0];
    const body = {
      matterId: mid,
      requestId: randomUUID(),
      title: "Host-written memorandum",
      content: "The source states: " + evidence.text,
      citations: [
        {
          documentId: doc.id,
          paragraph: evidence.paragraph,
          quote: evidence.text,
        },
      ],
    };
    const created = await call("create_draft", body);
    assert.equal(created.data.reviewStatus, "unreviewed");
    assert.equal((await call("create_draft", body)).data.id, created.data.id);
    assert.equal(
      (
        await direct(writeKey.token, "create_draft", {
          ...body,
          title: "Changed input",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await direct(writeKey.token, "create_draft", {
          ...body,
          requestId: randomUUID(),
          citations: [
            { documentId: doc.id, paragraph: 1, quote: "Invented quote" },
          ],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await direct(writeKey.token, "read_draft", {
          matterId: hidden.id,
          draftId: created.data.id,
        })
      ).status,
      404,
    );
    const read = await call("read_draft", {
      matterId: mid,
      draftId: created.data.id,
    });
    assert.equal(read.data.content, body.content);
    const review = await call("create_review", {
      matterId: mid,
      requestId: randomUUID(),
      name: "Host evidence table",
      columns: ["Governing law"],
      documentIds: [doc.id],
    });
    assert.equal(review.data.cellCount, 1);
    const semanticBody = {
      matterId: mid,
      requestId: randomUUID(),
      name: "Host analysis table",
      columns: ["Interpretation"],
      rows: [
        {
          documentId: doc.id,
          cells: [
            {
              value:
                "The supplied clause selects a governing law; check the exact quote.",
              citations: [
                {
                  documentId: doc.id,
                  paragraph: evidence.paragraph,
                  quote: evidence.text,
                },
              ],
            },
          ],
        },
      ],
    };
    const semantic = await call("save_review", semanticBody);
    assert.equal(semantic.data.reviewStatus, "unreviewed");
    assert.equal(
      (await call("save_review", semanticBody)).data.id,
      semantic.data.id,
    );
    const semanticRead = await call("read_review", {
      matterId: mid,
      reviewId: semantic.data.id,
    });
    assert.equal(semanticRead.data.items[0].reviewed, false);
    assert.equal(
      (
        await direct(writeKey.token, "save_review", {
          ...semanticBody,
          requestId: randomUUID(),
          rows: [{ documentId: doc.id, cells: [] }],
        })
      ).status,
      400,
    );
    const longDoc = await call("import_text", {
      matterId: mid,
      requestId: randomUUID(),
      name: "Long paragraph",
      text: "x".repeat(8000) + "TAIL",
    });
    const firstPage = await call("read_document", {
      matterId: mid,
      documentId: longDoc.data.id,
    });
    assert.equal(firstPage.data.nextParagraph, 1);
    assert.equal(firstPage.data.nextParagraphOffset, 6000);
    const remainder = await call("read_document", {
      matterId: mid,
      documentId: longDoc.data.id,
      startParagraph: 1,
      paragraphOffset: firstPage.data.nextParagraphOffset,
    });
    assert.ok(remainder.data.paragraphs[0].text.endsWith("TAIL"));
    assert.equal(remainder.data.nextParagraph, null);
    const imported = await call("import_text", {
      matterId: mid,
      requestId: randomUUID(),
      name: "Host notes",
      text: "Synthetic evidence notes. No model API call.",
    });
    assert.ok(imported.data.id);
    const task = await call("create_task", {
      matterId: mid,
      requestId: randomUUID(),
      title: "Verify the memorandum citations",
    });
    assert.ok(task.data.id);
    assert.equal(
      (await client.listPrompts()).prompts[0].name,
      "counsel_prepare_matter_memo",
    );
    const ownerSession = { cookie, csrf };
    await api("admin/users", {
      email: "editor@mcp.test",
      password: "Editor MCP passphrase for testing",
      role: "editor",
    });
    const member = (await api("admin/users")).data.find(
      (u) => u.email === "editor@mcp.test",
    );
    await api("admin/access", {
      userId: member.id,
      matterId: mid,
      allowed: true,
    });
    await api("auth/login", {
      email: "editor@mcp.test",
      password: "Editor MCP passphrase for testing",
    });
    const memberKey = (
      await api("agent-tokens", { name: "Editor key", matterIds: [mid] })
    ).data;
    cookie = ownerSession.cookie;
    csrf = ownerSession.csrf;
    await api("admin/access", {
      userId: member.id,
      matterId: mid,
      allowed: false,
    });
    assert.equal(
      (
        await direct(memberKey.token, "read_document", {
          matterId: mid,
          documentId: doc.id,
        })
      ).status,
      404,
    );
    await api("admin/users/" + member.id, { disabled: true }, "PATCH");
    assert.equal((await direct(memberKey.token, "session", {})).status, 401);
    const blocked = await fetch(origin + "/agent/v1/session", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + readKey.token,
        Origin: "https://untrusted.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(blocked.status, 403);
    await api("agent-tokens/" + writeKey.id, undefined, "DELETE");
    const revoked = await client.callTool({
      name: "counsel_session",
      arguments: {},
    });
    assert.equal(revoked.isError, true);
    assert.match(revoked.content[0].text, /revoked/);
    db.prepare("UPDATE agent_tokens SET expires=0 WHERE id=?").run(readKey.id);
    assert.equal((await direct(readKey.token, "session", {})).status, 401);
  } finally {
    await client?.close();
    await workflows.close();
    await jobs.close();
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
});
test("MCP connection files reject non-HTTPS remote URLs and embedded URL credentials", async () => {
  const { loadConnection } = await import("../mcp/server.mjs");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "counsel-mcp-config-")),
    file = path.join(folder, "key.json");
  try {
    for (const url of [
      "http://remote.example",
      "https://user:secret@example.test",
      "https://example.test/private",
      "https://example.test/?token=x",
    ]) {
      fs.writeFileSync(
        file,
        JSON.stringify({ url, token: "counsel_" + "a".repeat(64) }),
      );
      assert.throws(() => loadConnection(file));
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
