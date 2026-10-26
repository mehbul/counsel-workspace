const { DatabaseSync } = require("node:sqlite");
const { createHash, createDecipheriv } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const required = {
  state: ["id", "value"],
  workspaces: ["id", "name", "value"],
  users: ["id", "email", "password", "workspace_id", "role", "disabled"],
  sessions: ["hash", "user_id", "csrf", "expires"],
  audit: ["id", "workspace_id", "actor", "action", "resource", "created"],
  settings: ["key", "value"],
  matter_access: ["user_id", "matter_id", "workspace_id"],
};
function inspectDatabase(filename, options = {}) {
  const report = { ok: false, checks: [], counts: {}, warnings: [] };
  const check = (name, ok) => report.checks.push({ name, ok });
  if (!fs.existsSync(filename)) {
    check("database exists", false);
    return report;
  }
  let db;
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    check(
      "SQLite integrity",
      db
        .prepare("PRAGMA integrity_check")
        .all()
        .every((row) => row.integrity_check === "ok"),
    );
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    for (const [table, columns] of Object.entries(required)) {
      const actual = tables.has(table)
        ? db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .map((row) => row.name)
        : [];
      check(
        "schema " + table,
        columns.every((column) => actual.includes(column)),
      );
    }
    if (report.checks.some((item) => !item.ok)) return report;
    const documents = new Map();
    let statesValid = true;
    for (const row of db.prepare("SELECT id,value FROM workspaces").iterate()) {
      try {
        const state = JSON.parse(row.value);
        if (!Array.isArray(state.matters) || !Array.isArray(state.documents))
          throw Error();
        const matters = new Set(state.matters.map((m) => m.id));
        for (const doc of state.documents) {
          if (!doc.id || !matters.has(doc.matterId)) statesValid = false;
          documents.set(row.id + "\0" + doc.id, doc);
        }
      } catch {
        statesValid = false;
      }
    }
    check("workspace state and matter references", statesValid);
    report.counts.workspaces = db
      .prepare("SELECT COUNT(*) n FROM workspaces")
      .get().n;
    report.counts.users = db.prepare("SELECT COUNT(*) n FROM users").get().n;
    report.counts.documents = documents.size;
    check(
      "user workspace references",
      db
        .prepare(
          "SELECT COUNT(*) n FROM users u LEFT JOIN workspaces w ON w.id=u.workspace_id WHERE w.id IS NULL",
        )
        .get().n === 0,
    );
    check(
      "session user references",
      db
        .prepare(
          "SELECT COUNT(*) n FROM sessions s LEFT JOIN users u ON u.id=s.user_id WHERE u.id IS NULL",
        )
        .get().n === 0,
    );
    const retained = new Set();
    let originalsValid = true;
    if (tables.has("document_originals")) {
      for (const row of db
        .prepare(
          "SELECT workspace_id,document_id,matter_id,sha256,bytes FROM document_originals",
        )
        .iterate()) {
        const identity = row.workspace_id + "\0" + row.document_id,
          doc = documents.get(identity);
        if (
          !doc ||
          doc.matterId !== row.matter_id ||
          createHash("sha256").update(row.bytes).digest("hex") !== row.sha256
        )
          originalsValid = false;
        if (doc?.original?.sha256 && doc.original.sha256 !== row.sha256)
          originalsValid = false;
        retained.add(identity);
      }
    }
    check("original blob hashes and references", originalsValid);
    check(
      "promised original files present",
      [...documents].every(([id, doc]) => !doc.original || retained.has(id)),
    );
    report.counts.originals = retained.size;
    const unavailable = [...documents].filter(
      ([id, doc]) => !doc.sample && !retained.has(id),
    ).length;
    if (unavailable)
      report.warnings.push(
        `${unavailable} documents have no retained original; legacy imports and generated text may lack originals.`,
      );
    const keyDirectory = options.keyDir || path.dirname(filename);
    for (const [table, keyName, aad] of [
      ["connectors", "integration-key", false],
      ["model_settings", "model-key", true],
    ]) {
      if (!tables.has(table)) continue;
      const rows = db.prepare(`SELECT workspace_id,config FROM ${table}`).all();
      report.counts[table] = rows.length;
      if (!rows.length) continue;
      let valid = true;
      try {
        const key = fs.readFileSync(path.join(keyDirectory, keyName));
        if (key.length !== 32) throw Error();
        for (const row of rows) {
          const bytes = Buffer.from(row.config, "base64"),
            cipher = createDecipheriv(
              "aes-256-gcm",
              key,
              bytes.subarray(0, 12),
            );
          if (aad) cipher.setAAD(Buffer.from(row.workspace_id));
          cipher.setAuthTag(bytes.subarray(-16));
          JSON.parse(
            Buffer.concat([
              cipher.update(bytes.subarray(12, -16)),
              cipher.final(),
            ]).toString(),
          );
        }
      } catch {
        valid = false;
      }
      check(`${table} encryption key decrypts saved settings`, valid);
    }
    report.ok = report.checks.every((item) => item.ok);
    return report;
  } catch {
    check("database readable with expected schema", false);
    return report;
  } finally {
    db?.close();
  }
}
if (require.main === module) {
  const filename = process.argv[2],
    keyDir = process.argv[3];
  if (
    !filename ||
    !path.isAbsolute(filename) ||
    (keyDir && !path.isAbsolute(keyDir))
  ) {
    console.error(
      "Usage: node scripts/restore-check.js /absolute/backup.db [/absolute/key-directory]",
    );
    process.exitCode = 1;
  } else {
    const report = inspectDatabase(filename, { keyDir });
    console.log(
      JSON.stringify(
        {
          ...report,
          mode: "read-only restore dry run; no server startup or external calls",
        },
        null,
        2,
      ),
    );
    process.exitCode = report.ok ? 0 : 1;
  }
}
module.exports = { inspectDatabase };
