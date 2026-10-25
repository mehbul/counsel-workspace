// Optional live check. Uses a temporary synthetic workspace, never the user's database.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const model = process.env.OLLAMA_MODEL || process.argv[2];
if (!model) {
  console.error(
    "Usage: node scripts/smoke-local-model.js your-installed-ollama-model",
  );
  process.exit(1);
}
process.env.COUNSEL_DB = ":memory:";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "counsel-local-smoke-"),
);
process.env.AI_PROVIDER = "ollama";
process.env.OLLAMA_MODEL = model;
const { app, db, jobs, workflows, collaboration } = require("../server");
const server = app.listen(0, "127.0.0.1");
server.once("listening", async () => {
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  try {
    const setup = await fetch(base + "auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: fs.readFileSync(
          path.join(process.env.DATA_DIR, "bootstrap-token"),
          "utf8",
        ),
        email: "synthetic-local-model@example.test",
        password: "Synthetic local model smoke passphrase",
        workspace: "Synthetic local model smoke",
      }),
    });
    if (!setup.ok) throw Error("Synthetic account setup failed.");
    const session = await setup.json(),
      cookie = setup.headers.get("set-cookie").split(";")[0];
    const state = await (
      await fetch(base + "state", { headers: { Cookie: cookie } })
    ).json();
    const document = state.documents[0];
    const response = await fetch(base + "chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": session.csrf,
      },
      body: JSON.stringify({
        matterId: state.matters[0].id,
        documentIds: [document.id],
        query:
          "Which law governs this agreement? Give one sentence and cite the source.",
      }),
    });
    const result = await response.json();
    if (
      !response.ok ||
      result.mode !== "Local model analysis" ||
      !result.citations.length ||
      !result.text.trim()
    )
      throw Error("Local model workflow did not return a cited response.");
    console.log(
      JSON.stringify({
        status: "ok",
        model,
        mode: result.mode,
        sourceCount: result.citations.length,
        response: result.text,
      }),
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await workflows.close();
    await jobs.close();
    collaboration.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    const directory = path.resolve(process.env.DATA_DIR);
    if (
      path.dirname(directory) === path.resolve(os.tmpdir()) &&
      path.basename(directory).startsWith("counsel-local-smoke-")
    )
      fs.rmSync(directory, { recursive: true, force: true });
  }
});
