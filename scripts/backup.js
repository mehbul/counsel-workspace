const { DatabaseSync, backup } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
const destination = process.argv[2];
if (!destination) {
  console.error("Usage: node scripts/backup.js /absolute/path/new-backup.db");
  process.exit(1);
}
if (!path.isAbsolute(destination) || fs.existsSync(destination)) {
  console.error(
    "Use a new absolute destination path; existing backups are never overwritten.",
  );
  process.exit(1);
}
const source =
  process.env.COUNSEL_DB ||
  path.join(
    process.env.DATA_DIR || path.join(__dirname, "..", "data"),
    "workspace.db",
  );
const db = new DatabaseSync(source, { readOnly: true });
backup(db, destination)
  .then(() => {
    db.close();
    const check = new DatabaseSync(destination, { readOnly: true });
    if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw Error("Backup integrity check failed");
    check.close();
    fs.chmodSync(destination, 0o600);
    console.log(
      "Verified backup created. Store it on an encrypted off-host volume.",
    );
  })
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
