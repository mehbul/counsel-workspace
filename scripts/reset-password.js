// Offline recovery requires local filesystem access. Stop the application first.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const argon2 = require("argon2");
(async () => {
  const [email, passwordFile] = process.argv.slice(2);
  if (!email || !passwordFile)
    throw Error(
      "Usage: node scripts/reset-password.js user@example.com /private/password-file",
    );
  const password = fs.readFileSync(passwordFile, "utf8").replace(/\r?\n$/, "");
  if (password.length < 14 || password.length > 256)
    throw Error("Password must contain 14–256 characters.");
  const db = new DatabaseSync(
    process.env.COUNSEL_DB ||
      path.join(
        process.env.DATA_DIR || path.join(__dirname, "..", "data"),
        "workspace.db",
      ),
  );
  const u = db
    .prepare("SELECT id FROM users WHERE email=?")
    .get(email.trim().toLowerCase());
  if (!u) throw Error("Account not found.");
  const encoded = await argon2.hash(password);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE users SET password=? WHERE id=?").run(encoded, u.id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  db.close();
  console.log(
    "Password reset and all sessions revoked. Remove the private password file.",
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
