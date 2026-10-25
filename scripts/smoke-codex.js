// Optional live Codex acceptance check. Uses ChatGPT sign-in and synthetic data.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
process.env.COUNSEL_DB = ":memory:";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "counsel-codex-smoke-"),
);
process.env.AI_PROVIDER = "evidence";
const { app, db, jobs, workflows, collaboration } = require("../server");
const server = app.listen(0, "127.0.0.1");
server.once("listening", async () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = "",
    csrf = "",
    keyId;
  async function api(p, body, method = body ? "POST" : "GET") {
    const r = await fetch(origin + "/api/" + p, {
      method,
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.headers.get("set-cookie"))
      cookie = r.headers.get("set-cookie").split(";")[0];
    const data = await r.json();
    if (data.csrf) csrf = data.csrf;
    if (!r.ok) throw Error("Synthetic workspace operation failed: " + p);
    return data;
  }
  try {
    await api("auth/setup", {
      token: fs.readFileSync(
        path.join(process.env.DATA_DIR, "bootstrap-token"),
        "utf8",
      ),
      email: "synthetic-codex@example.test",
      password: "Synthetic Codex MCP test passphrase",
      workspace: "Synthetic Codex acceptance test",
    });
    const initial = await api("state"),
      matterId = initial.matters[0].id;
    const key = await api("agent-tokens", {
      name: "Ephemeral Codex acceptance",
      mode: "write",
      matterIds: [matterId],
      expiresInDays: 1,
    });
    keyId = key.id;
    const connection = path.join(
      process.env.DATA_DIR,
      "counsel-connection.json",
    );
    fs.writeFileSync(
      connection,
      JSON.stringify({ url: origin, token: key.token }),
      { mode: 0o600 },
    );
    const args = [
      "exec",
      "--ignore-user-config",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--json",
      "-C",
      process.env.DATA_DIR,
      "-c",
      'approval_policy="never"',
      "-c",
      "mcp_servers.counsel.command=" + JSON.stringify(process.execPath),
      "-c",
      "mcp_servers.counsel.args=" +
        JSON.stringify([
          path.resolve(__dirname, "../mcp/server.mjs"),
          "--connection-file",
          connection,
        ]),
      "-c",
      "mcp_servers.counsel.required=true",
      "-c",
      "mcp_servers.counsel.startup_timeout_sec=30",
      "-c",
      'mcp_servers.counsel.default_tools_approval_mode="approve"',
      "Run a live acceptance test using ONLY the counsel MCP tools. Do not run shell commands, read local files, use other tools, or change client settings. List authorized matters and documents. In Project Northstar, find the Mutual NDA between Acme and Northstar, read its governing-law paragraph, and identify the jurisdiction. Save YOUR short source-grounded analysis as a one-column review with one NDA row using counsel_save_review, and save a draft titled Codex MCP acceptance memorandum using counsel_create_draft. Both outputs must include an exact quote from the actual numbered source paragraph. Generate a fresh valid UUID requestId for each write. Keep both outputs unreviewed. No separate model API should be called through Counsel. After the tools succeed, return only a JSON object with draftId, reviewId and governingLaw.",
    ];
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    const trace = await new Promise((resolve, reject) => {
      const child = spawn(process.env.CODEX_BIN || "codex", args, {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("Codex acceptance test timed out."));
      }, 180000);
      child.stdout.on("data", (b) => {
        stdout += b.toString();
        if (stdout.length > 4000000) child.kill();
      });
      child.stderr.on("data", (b) => {
        stderr += b.toString();
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        fs.writeFileSync(
          path.join(process.env.DATA_DIR, "codex-trace.jsonl"),
          stdout,
        );
        if (code !== 0) {
          console.error(stderr.slice(-2500));
          reject(Error("Codex exited with code " + code));
        } else resolve(stdout);
      });
    });
    const events = trace
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const calls = events
      .map((e) => e.item)
      .filter((i) => i?.type === "mcp_tool_call");
    const toolNames = [...new Set(calls.map((c) => c.tool))];
    if (events.some((e) => e.item?.type === "command_execution"))
      throw Error("Codex used a shell instead of the requested MCP-only path.");
    const state = await api("state"),
      draft = state.drafts.find(
        (d) =>
          d.title === "Codex MCP acceptance memorandum" &&
          d.origin === "connected-assistant",
      ),
      review = state.reviews.find((r) => r.origin === "connected-assistant");
    if (
      !draft ||
      !review ||
      !draft.content.includes("England and Wales") ||
      !draft.citations.length ||
      review.cells.some((c) => c.reviewed)
    )
      throw Error(
        "Codex did not produce the expected cited, unreviewed artifacts.",
      );
    if (
      !toolNames.includes("counsel_create_draft") ||
      !toolNames.includes("counsel_save_review")
    )
      throw Error("The trace did not confirm the required MCP calls.");
    console.log(
      JSON.stringify({
        status: "ok",
        host: "Codex CLI",
        authentication: "existing ChatGPT sign-in",
        serverModelProvider: "evidence",
        toolNames,
        draftId: draft.id,
        reviewId: review.id,
        governingLaw: "England and Wales",
        draftExcerpt: draft.content.slice(0, 1200),
      }),
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    if (keyId)
      await api("agent-tokens/" + keyId, undefined, "DELETE").catch(() => {});
    await workflows.close();
    await jobs.close();
    collaboration.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    const directory = path.resolve(process.env.DATA_DIR);
    if (
      path.dirname(directory) === path.resolve(os.tmpdir()) &&
      path.basename(directory).startsWith("counsel-codex-smoke-")
    )
      fs.rmSync(directory, { recursive: true, force: true });
  }
});
