const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createSecretBox } = require("../secret-box");
const { inspectDatabase } = require("../scripts/restore-check");

test("restore check verifies notification credentials even without connectors and never creates missing keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "counsel-restore-"));
  const filename = path.join(dir, "backup.db");
  const db = new DatabaseSync(filename);
  try {
    db.exec(`CREATE TABLE state(id,value);
      CREATE TABLE workspaces(id,name,value);
      CREATE TABLE users(id,email,password,workspace_id,role,disabled);
      CREATE TABLE sessions(hash,user_id,csrf,expires);
      CREATE TABLE audit(id,workspace_id,actor,action,resource,created);
      CREATE TABLE settings(key,value);
      CREATE TABLE matter_access(user_id,matter_id,workspace_id);
      CREATE TABLE notification_channels(workspace_id,url,secret);`);
    const { seal } = createSecretBox(dir);
    db.prepare("INSERT INTO notification_channels VALUES(?,?,?)").run(
      "w",
      seal("https://example.com/hook"),
      seal("private-signing-secret"),
    );
    assert.equal(inspectDatabase(filename).ok, true);
    db.prepare("UPDATE notification_channels SET secret=?").run("corrupted");
    assert.equal(inspectDatabase(filename).ok, false);
    db.prepare("UPDATE notification_channels SET secret=NULL").run();
    assert.equal(inspectDatabase(filename).ok, true);
    fs.unlinkSync(path.join(dir, "integration-key"));
    assert.equal(inspectDatabase(filename).ok, false);
    assert.equal(fs.existsSync(path.join(dir, "integration-key")), false);
    assert.ok(
      !JSON.stringify(inspectDatabase(filename)).includes(
        "private-signing-secret",
      ),
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
