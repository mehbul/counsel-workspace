const { AsyncLocalStorage } = require("node:async_hooks");
const {
  randomBytes,
  createHash,
  randomUUID,
  timingSafeEqual,
} = require("node:crypto");
const argon2 = require("argon2");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { z } = require("zod");
const fs = require("node:fs");
const path = require("node:path");
const context = new AsyncLocalStorage();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("hex");
const passwordSchema = z.string().min(14).max(256);
const emailSchema = z.string().trim().toLowerCase().email().max(254);
function installSecurity(app, db, initial) {
  const production = process.env.NODE_ENV === "production";
  if (
    production &&
    (!process.env.APP_ORIGIN?.startsWith("https://") ||
      !process.env.COOKIE_SECURE)
  )
    throw Error("Production requires HTTPS APP_ORIGIN and COOKIE_SECURE=true");
  const secure = process.env.COOKIE_SECURE === "true";
  if (production && !secure) throw Error("Production cookies must be secure");
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,workspace_id TEXT NOT NULL,role TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,workspace_id TEXT,actor TEXT,action TEXT NOT NULL,resource TEXT,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS matter_access(user_id TEXT NOT NULL,matter_id TEXT NOT NULL,workspace_id TEXT NOT NULL,PRIMARY KEY(user_id,matter_id));`);
  const setupFile = path.join(
    process.env.DATA_DIR || path.join(__dirname, "data"),
    "bootstrap-token",
  );
  if (
    !db.prepare("SELECT id FROM users LIMIT 1").get() &&
    !db.prepare("SELECT value FROM settings WHERE key='bootstrap'").get()
  ) {
    const secret = token();
    fs.mkdirSync(path.dirname(setupFile), { recursive: true });
    fs.writeFileSync(setupFile, secret, { mode: 0o600 });
    db.prepare("INSERT INTO settings VALUES(?,?)").run(
      "bootstrap",
      hash(secret),
    );
  }
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          scriptSrcAttr: ["'unsafe-inline'"],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
          ],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          upgradeInsecureRequests: production ? [] : null,
        },
      },
      strictTransportSecurity: production ? undefined : false,
    }),
  );
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    req.requestId = randomUUID();
    res.set("X-Request-ID", req.requestId);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      const expected =
        process.env.APP_ORIGIN || `${req.protocol}://${req.get("host")}`;
      if (
        (origin && origin !== expected) ||
        req.get("sec-fetch-site") === "cross-site"
      )
        return res
          .status(403)
          .json({ error: "Cross-origin request rejected." });
    }
    next();
  });
  app.get("/health/live", (req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", (req, res) => {
    try {
      db.prepare("SELECT 1").get();
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests. Try again shortly." },
    }),
  );
  const loginLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 15,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Try again in 15 minutes." },
  });
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof z.ZodError)
        return res.status(400).json({
          error: e.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
      next(e);
    }
  };
  const audit = (workspace, actor, action, resource = "") =>
    db
      .prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)")
      .run(
        randomUUID(),
        workspace,
        actor,
        action,
        resource,
        new Date().toISOString(),
      );
  function revokeAssistantKeys(userId) {
    // Older databases may predate the optional assistant integration.
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_tokens'",
        )
        .get()
    )
      db.prepare("UPDATE agent_tokens SET revoked=1 WHERE user_id=?").run(
        userId,
      );
  }
  const cookie = (res, value, age) =>
    res.cookie("counsel_session", value, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      maxAge: age,
      path: "/",
    });
  function session(req) {
    const raw = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("counsel_session="))
      ?.slice(16);
    if (!raw || raw.length !== 64) return null;
    return db
      .prepare(
        "SELECT s.hash,s.csrf,s.expires,u.id,u.email,u.workspace_id,u.role,w.name FROM sessions s JOIN users u ON s.user_id=u.id JOIN workspaces w ON u.workspace_id=w.id WHERE s.hash=? AND s.expires>? AND u.disabled=0",
      )
      .get(hash(raw), Date.now());
  }
  function newSession(res, u) {
    const raw = token(),
      csrf = token(),
      age = 8 * 60 * 60000;
    db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
      hash(raw),
      u.id,
      csrf,
      Date.now() + age,
    );
    cookie(res, raw, age);
    return csrf;
  }
  app.get("/api/auth/me", (req, res) => {
    const s = session(req);
    res.json(
      s
        ? {
            user: { email: s.email, role: s.role, workspace: s.name },
            csrf: s.csrf,
          }
        : {
            user: null,
            setupRequired: !db.prepare("SELECT id FROM users LIMIT 1").get(),
          },
    );
  });
  app.post(
    "/api/auth/setup",
    loginLimit,
    wrap(async (req, res) => {
      const b = z
        .object({
          token: z.string().length(64),
          email: emailSchema,
          password: passwordSchema,
          workspace: z.string().trim().min(1).max(100),
        })
        .parse(req.body);
      const expected = db
        .prepare("SELECT value FROM settings WHERE key='bootstrap'")
        .get()?.value;
      if (
        db.prepare("SELECT id FROM users LIMIT 1").get() ||
        !expected ||
        !timingSafeEqual(Buffer.from(hash(b.token)), Buffer.from(expected))
      )
        return res
          .status(403)
          .json({ error: "Setup unavailable or token invalid." });
      const password = await argon2.hash(b.password, { type: argon2.argon2id });
      // Recheck after hashing: concurrent setup attempts must never create multiple owners.
      if (db.prepare("SELECT id FROM users LIMIT 1").get())
        return res.status(409).json({ error: "Setup already completed." });
      const uid = randomUUID(),
        wid = randomUUID();
      db.exec("BEGIN IMMEDIATE");
      try {
        const legacy = db
          .prepare("SELECT value FROM state WHERE id=1")
          .get()?.value;
        db.prepare("INSERT INTO workspaces VALUES(?,?,?)").run(
          wid,
          b.workspace,
          legacy || JSON.stringify(initial()),
        );
        db.prepare("INSERT INTO users VALUES(?,?,?,?,?,0)").run(
          uid,
          b.email,
          password,
          wid,
          "owner",
        );
        db.prepare("DELETE FROM settings WHERE key='bootstrap'").run();
        db.prepare("DELETE FROM state WHERE id=1").run();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      try {
        fs.unlinkSync(setupFile);
      } catch {}
      audit(wid, uid, "workspace.setup");
      res.json({ csrf: newSession(res, { id: uid }) });
    }),
  );
  app.post(
    "/api/auth/login",
    loginLimit,
    wrap(async (req, res) => {
      const b = z
        .object({ email: emailSchema, password: z.string().max(256) })
        .parse(req.body);
      const u = db.prepare("SELECT * FROM users WHERE email=?").get(b.email);
      const dummy =
        "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQxMjM0NTY3OA$ubF0wCGRmhTQqDMo1ZbpH0X1EVy1VjkhHZvowtpKThY";
      let valid = false;
      try {
        valid = await argon2.verify(u?.password || dummy, b.password);
      } catch {}
      if (!valid || !u || u.disabled) {
        audit(null, null, "login.failed");
        return res
          .status(401)
          .json({ error: "Email or password is incorrect." });
      }
      audit(u.workspace_id, u.id, "login.success");
      res.json({ csrf: newSession(res, u) });
    }),
  );
  app.use("/api", (req, res, next) => {
    const s = session(req);
    if (!s) return res.status(401).json({ error: "Sign in to continue." });
    req.user = s;
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.get("x-csrf-token") !== s.csrf
    )
      return res
        .status(403)
        .json({ error: "Session verification failed. Reload and try again." });
    next();
  });
  app.post("/api/auth/logout", (req, res) => {
    db.prepare("DELETE FROM sessions WHERE hash=?").run(req.user.hash);
    cookie(res, "", 0);
    res.json({ ok: true });
  });
  app.post(
    "/api/auth/password",
    loginLimit,
    wrap(async (req, res) => {
      const b = z
        .object({
          currentPassword: z.string().max(256),
          password: passwordSchema,
        })
        .parse(req.body);
      const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
      if (!(await argon2.verify(u.password, b.currentPassword)))
        return res
          .status(403)
          .json({ error: "Current password is incorrect." });
      const password = await argon2.hash(b.password);
      // Hashing yields: a logout, disable or competing password change may
      // have revoked the request's session while the expensive work ran.
      if (!session(req))
        return res
          .status(401)
          .json({ error: "Session revoked. Sign in again." });
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE users SET password=? WHERE id=?").run(
          password,
          u.id,
        );
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
        revokeAssistantKeys(u.id);
        audit(u.workspace_id, u.id, "password.changed");
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      res.json({ csrf: newSession(res, u) });
    }),
  );
  app.use("/api/admin", (req, res, next) =>
    req.user.role === "owner"
      ? next()
      : res.status(403).json({ error: "Workspace owner access required." }),
  );
  app.get("/api/admin/users", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT id,email,role,disabled FROM users WHERE workspace_id=?",
        )
        .all(req.user.workspace_id),
    ),
  );
  app.post(
    "/api/admin/users",
    wrap(async (req, res) => {
      const b = z
        .object({
          email: emailSchema,
          password: passwordSchema,
          role: z.enum(["editor", "viewer"]),
        })
        .parse(req.body);
      if (db.prepare("SELECT id FROM users WHERE email=?").get(b.email))
        return res
          .status(409)
          .json({ error: "Unable to create that account." });
      const password = await argon2.hash(b.password);
      const active = session(req);
      if (!active || active.role !== "owner")
        return res
          .status(401)
          .json({ error: "Session revoked. Sign in again." });
      if (db.prepare("SELECT id FROM users WHERE email=?").get(b.email))
        return res
          .status(409)
          .json({ error: "Unable to create that account." });
      db.prepare("INSERT INTO users VALUES(?,?,?,?,?,0)").run(
        randomUUID(),
        b.email,
        password,
        req.user.workspace_id,
        b.role,
      );
      audit(req.user.workspace_id, req.user.id, "member.created", b.email);
      res.json({ ok: true });
    }),
  );
  app.patch(
    "/api/admin/users/:id",
    wrap(async (req, res) => {
      const b = z.object({ disabled: z.boolean() }).parse(req.body);
      const u = db
        .prepare("SELECT * FROM users WHERE id=? AND workspace_id=?")
        .get(req.params.id, req.user.workspace_id);
      if (!u || u.role === "owner")
        return res
          .status(404)
          .json({ error: "Member not found or protected." });
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE users SET disabled=? WHERE id=?").run(
          b.disabled ? 1 : 0,
          u.id,
        );
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
        if (b.disabled) revokeAssistantKeys(u.id);
        audit(
          req.user.workspace_id,
          req.user.id,
          b.disabled ? "member.disabled" : "member.enabled",
          u.id,
        );
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      res.json({ ok: true });
    }),
  );
  app.get("/api/admin/access", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT user_id,matter_id FROM matter_access WHERE workspace_id=?",
        )
        .all(req.user.workspace_id),
    ),
  );
  app.post(
    "/api/admin/access",
    wrap(async (req, res) => {
      const b = z
        .object({
          userId: z.string().uuid(),
          matterId: z.string().uuid(),
          allowed: z.boolean(),
        })
        .parse(req.body);
      const u = db
        .prepare("SELECT id FROM users WHERE id=? AND workspace_id=?")
        .get(b.userId, req.user.workspace_id);
      const w = JSON.parse(
        db
          .prepare("SELECT value FROM workspaces WHERE id=?")
          .get(req.user.workspace_id).value,
      );
      if (!u || !w.matters.some((m) => m.id === b.matterId))
        return res.status(404).json({ error: "Member or matter not found." });
      if (b.allowed)
        db.prepare("INSERT OR IGNORE INTO matter_access VALUES(?,?,?)").run(
          b.userId,
          b.matterId,
          req.user.workspace_id,
        );
      else
        db.prepare(
          "DELETE FROM matter_access WHERE user_id=? AND matter_id=?",
        ).run(b.userId, b.matterId);
      audit(
        req.user.workspace_id,
        req.user.id,
        b.allowed ? "matter.access.granted" : "matter.access.revoked",
        b.matterId,
      );
      res.json({ ok: true });
    }),
  );
  app.get("/api/admin/audit", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT actor,action,resource,created FROM audit WHERE workspace_id=? ORDER BY created DESC LIMIT 500",
        )
        .all(req.user.workspace_id),
    ),
  );
  app.use("/api", (req, res, next) => {
    if (req.user.role === "viewer" && !["GET", "HEAD"].includes(req.method))
      return res
        .status(403)
        .json({ error: "Your account has read-only access." });
    next();
  });
  const queues = new Map();
  app.use("/api", async (req, res, next) => {
    const key = req.user.workspace_id;
    const q = queues.get(key) || { tail: Promise.resolve(), count: 0 };
    if (q.count >= 20)
      return res
        .status(503)
        .json({ error: "Workspace is busy. Retry shortly." });
    q.count++;
    queues.set(key, q);
    const previous = q.tail;
    let release;
    q.tail = new Promise((r) => (release = r));
    await previous;
    if (res.destroyed) {
      q.count--;
      release();
      return;
    }
    const active = session(req);
    if (!active) {
      q.count--;
      release();
      return res.status(401).json({ error: "Session revoked." });
    }
    req.user = active;
    const row = db.prepare("SELECT value FROM workspaces WHERE id=?").get(key);
    if (!row) {
      q.count--;
      release();
      return res.sendStatus(403);
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      q.count--;
      release();
      if (!q.count) queues.delete(key);
    };
    res.once("finish", finish);
    const originalEnd = res.end;
    res.end = function (...args) {
      try {
        return originalEnd.apply(this, args);
      } finally {
        finish();
      }
    }; // Do not release on disconnect: async mutation may still be running.
    const fullState = JSON.parse(row.value);
    let scoped = structuredClone(fullState);
    if (req.user.role !== "owner") {
      const allowed = new Set(
        db
          .prepare(
            "SELECT matter_id FROM matter_access WHERE user_id=? AND workspace_id=?",
          )
          .all(req.user.id, key)
          .map((g) => g.matter_id),
      );
      scoped.matters = scoped.matters.filter((m) => allowed.has(m.id));
      for (const collection of [
        "documents",
        "messages",
        "reviews",
        "drafts",
        "tasks",
      ])
        scoped[collection] = scoped[collection].filter((x) =>
          allowed.has(x.matterId),
        );
      scoped.activity = [];
    }
    context.run(
      {
        workspaceId: key,
        actor: req.user.id,
        role: req.user.role,
        state: scoped,
        fullState,
        db,
        audit,
      },
      () => next(),
    );
  });
  async function runWorkspace(userId, workspaceId, fn) {
    const key = workspaceId,
      q = queues.get(key) || { tail: Promise.resolve(), count: 0 };
    q.count++;
    queues.set(key, q);
    const previous = q.tail;
    let release;
    q.tail = new Promise((r) => (release = r));
    await previous;
    try {
      const user = db
        .prepare(
          "SELECT * FROM users WHERE id=? AND workspace_id=? AND disabled=0",
        )
        .get(userId, key);
      if (!user || user.role === "viewer") throw Error("Run access revoked");
      const row = db
        .prepare("SELECT value FROM workspaces WHERE id=?")
        .get(key);
      const fullState = JSON.parse(row.value),
        scoped = structuredClone(fullState);
      if (user.role !== "owner") {
        const allowed = new Set(
          db
            .prepare(
              "SELECT matter_id FROM matter_access WHERE user_id=? AND workspace_id=?",
            )
            .all(userId, key)
            .map((g) => g.matter_id),
        );
        scoped.matters = scoped.matters.filter((m) => allowed.has(m.id));
        for (const collection of [
          "documents",
          "messages",
          "reviews",
          "drafts",
          "tasks",
        ])
          scoped[collection] = scoped[collection].filter((x) =>
            allowed.has(x.matterId),
          );
        scoped.activity = [];
      }
      return await context.run(
        {
          workspaceId: key,
          actor: userId,
          role: user.role,
          state: scoped,
          fullState,
          db,
          audit,
        },
        fn,
      );
    } finally {
      q.count--;
      release();
      if (!q.count) queues.delete(key);
    }
  }
  return { context, audit, runWorkspace, session };
}
const text = (max = 1000) => z.string().trim().min(1).max(max);
const schemas = {
  "POST /matters": z.object({
    name: text(200),
    client: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
  }),
  "POST /chat": z.object({
    matterId: z.string().uuid(),
    query: text(20000),
    documentIds: z.array(z.string().uuid()).max(100).optional(),
    skillId: z.union([z.literal(""), z.string().uuid()]).optional(),
  }),
  "POST /reviews": z.object({
    matterId: z.string().uuid(),
    name: z.string().max(200).optional(),
    columns: z.array(text(500)).min(1).max(12),
    documentIds: z.array(z.string().uuid()).max(100).optional(),
  }),
  "POST /drafts": z.object({
    matterId: z.string().uuid(),
    title: z.string().max(200).optional(),
    prompt: z.string().max(20000).optional(),
    documentIds: z.array(z.string().uuid()).max(100).optional(),
    instructions: z.string().max(20000).optional(),
  }),
  "POST /skills": z.object({
    name: text(200),
    category: z.string().max(100).optional(),
    instructions: text(20000),
  }),
  "POST /tasks": z.object({ matterId: z.string().uuid(), title: text(500) }),
};
function validate(req, res, next) {
  const schema =
    schemas[`${req.method} ${req.path}`] ||
    (req.method === "PATCH" &&
    req.path.startsWith("/drafts/") &&
    !req.path.includes("/comments/") &&
    !req.path.includes("/suggestions/")
      ? z.object({
          title: text(200).optional(),
          content: z.string().max(1000000).optional(),
        })
      : req.method === "PATCH" && req.path.includes("/cells/")
        ? z.object({
            locked: z.boolean().optional(),
            reviewed: z.boolean().optional(),
            value: z.string().max(100000).optional(),
          })
        : null);
  if (schema) {
    const result = schema.safeParse(req.body);
    if (!result.success)
      return res.status(400).json({
        error: result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    req.body = result.data;
  }
  const current = context.getStore()?.state;
  if (
    req.body?.matterId &&
    current &&
    !current.matters.some((m) => m.id === req.body.matterId)
  )
    return res.status(404).json({ error: "Matter not found." });
  next();
}
module.exports = { installSecurity, context, validate };
