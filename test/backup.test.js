const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
test("online backup preserves committed WAL records and refuses overwrite", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "counsel-backup-")),
    source = path.join(dir, "source.db"),
    destination = path.join(dir, "backup.db");
  const db = new DatabaseSync(source);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE evidence(id INTEGER,value TEXT); INSERT INTO evidence VALUES(1,'preserve me');",
    );
    const run = () =>
      spawnSync(process.execPath, ["scripts/backup.js", destination], {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, COUNSEL_DB: source },
        encoding: "utf8",
      });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const copy = new DatabaseSync(destination, { readOnly: true });
    assert.equal(
      copy.prepare("SELECT value FROM evidence").get().value,
      "preserve me",
    );
    copy.close();
    assert.equal(run().status, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
