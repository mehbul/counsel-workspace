const { randomUUID, randomBytes } = require("node:crypto");

const loopbackNames = new Set(["127.0.0.1", "::1", "localhost"]);
const loopbackPeers = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const hostPattern = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?$/i;

function localOrigin(value) {
  if (typeof value !== "string" || !/^http:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (!hostPattern.test(value.replace(/^http:\/\//i, "").replace(/\/$/, "")))
      return null;
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

// This is an explicit local mode, never a fallback for failed authentication.
function createPersonalMode(db, env = process.env) {
  if (env.COUNSEL_PERSONAL !== "true") return null;
  if (env.NODE_ENV === "production")
    throw Error(
      "Personal mode cannot run in production or a published Docker service. Use the authenticated team mode.",
    );
  if (!loopbackNames.has((env.HOST || "127.0.0.1").toLowerCase()))
    throw Error("Personal mode requires HOST=127.0.0.1, ::1 or localhost.");
  if (env.TRUST_PROXY === "1")
    throw Error("Personal mode does not permit a reverse proxy.");
  if (env.COOKIE_SECURE === "true")
    throw Error("Personal mode uses local HTTP. Set COOKIE_SECURE=false.");
  const expectedOrigin = env.APP_ORIGIN ? localOrigin(env.APP_ORIGIN) : null;
  if (env.APP_ORIGIN && !expectedOrigin)
    throw Error("Personal mode APP_ORIGIN must be an HTTP loopback origin.");
  const exists = (table) =>
    !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
  function markedIdentity() {
    if (!exists("personal_database")) return null;
    const marker = db
      .prepare("SELECT * FROM personal_database WHERE id=1")
      .get();
    if (!marker || !exists("users") || !exists("workspaces"))
      throw Error(
        "Personal database marker is incomplete. Restore the personal database from backup.",
      );
    const user = db
      .prepare(
        "SELECT u.id,u.email,u.role,u.disabled,u.workspace_id,w.name FROM users u JOIN workspaces w ON w.id=u.workspace_id WHERE u.id=? AND u.workspace_id=?",
      )
      .get(marker.owner_id, marker.workspace_id);
    if (
      !user ||
      user.role !== "owner" ||
      user.disabled ||
      user.email !== "personal@localhost.invalid" ||
      db.prepare("SELECT COUNT(*) n FROM users").get().n !== 1 ||
      db.prepare("SELECT COUNT(*) n FROM workspaces").get().n !== 1
    )
      throw Error(
        "Personal database identity changed. Refusing automatic access to a shared or modified account database.",
      );
    return user;
  }
  function freshDatabase() {
    if (
      (exists("users") && db.prepare("SELECT COUNT(*) n FROM users").get().n) ||
      (exists("workspaces") &&
        db.prepare("SELECT COUNT(*) n FROM workspaces").get().n) ||
      (exists("state") && db.prepare("SELECT 1 FROM state LIMIT 1").get()) ||
      (exists("settings") &&
        db.prepare("SELECT 1 FROM settings WHERE key='bootstrap'").get())
    )
      throw Error(
        "Refusing personal mode on an existing team or legacy database. Use a new DATA_DIR such as data/personal.",
      );
  }
  // Read-only preflight: never convert an existing team database automatically.
  if (!markedIdentity()) freshDatabase();
  function initialize(initial) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!markedIdentity()) {
        freshDatabase();
        const ownerId = randomUUID(),
          workspaceId = randomUUID();
        db.exec(
          "CREATE TABLE personal_database(id INTEGER PRIMARY KEY CHECK(id=1),owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL)",
        );
        db.prepare("INSERT INTO workspaces VALUES(?,?,?)").run(
          workspaceId,
          "Personal workspace",
          JSON.stringify(initial()),
        );
        // No usable login password is created; local mode has no password endpoint.
        db.prepare("INSERT INTO users VALUES(?,?,?,?,?,0)").run(
          ownerId,
          "personal@localhost.invalid",
          "!personal:" + randomBytes(32).toString("hex"),
          workspaceId,
          "owner",
        );
        db.prepare("INSERT INTO personal_database VALUES(1,?,?)").run(
          ownerId,
          workspaceId,
        );
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return markedIdentity();
  }
  function validateRequest(req) {
    if (!loopbackPeers.has(req.socket?.remoteAddress)) return false;
    const headers = Object.fromEntries(
      Object.entries(req.headers || {}).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    if (
      Object.keys(headers).some(
        (key) =>
          key === "forwarded" ||
          key === "via" ||
          key === "x-real-ip" ||
          key.startsWith("x-forwarded") ||
          key.startsWith("xforwarded"),
      )
    )
      return false;
    const host = headers.host;
    if (typeof host !== "string" || !hostPattern.test(host)) return false;
    const origin = localOrigin("http://" + host);
    if (!origin || (expectedOrigin && expectedOrigin !== origin)) return false;
    if (headers.origin !== undefined && headers.origin !== origin) return false;
    if (
      headers["sec-fetch-site"] !== undefined &&
      !["same-origin", "none"].includes(headers["sec-fetch-site"])
    )
      return false;
    return true;
  }
  return { initialize, identity: markedIdentity, validateRequest };
}

module.exports = { createPersonalMode };
