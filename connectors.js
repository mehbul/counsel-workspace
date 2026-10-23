const {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { z } = require("zod");
const { context } = require("./security");
const { parseDocument } = require("./parser");
const graphOrigin = "https://graph.microsoft.com",
  googleOrigin = "https://www.googleapis.com";
const safeId = z.string().regex(/^[a-zA-Z0-9_!.,:@-]{1,300}$/);
function createConnectors(app, db, security, save, enqueue, options = {}) {
  const fetcher = options.fetch || fetch;
  const keyPath = path.join(
    process.env.DATA_DIR || path.join(__dirname, "data"),
    "integration-key",
  );
  if (!fs.existsSync(keyPath))
    fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) throw Error("Invalid integration encryption key");
  const seal = (value) => {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([
      iv,
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  };
  const open = (value) => {
    const b = Buffer.from(value, "base64"),
      cipher = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(-16));
    return JSON.parse(
      Buffer.concat([
        cipher.update(b.subarray(12, -16)),
        cipher.final(),
      ]).toString(),
    );
  };
  db.exec(
    "CREATE TABLE IF NOT EXISTS connectors(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,name TEXT NOT NULL,provider TEXT NOT NULL,config TEXT NOT NULL,last_sync TEXT,status TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connector_items(connector_id TEXT NOT NULL,remote_id TEXT NOT NULL,document_id TEXT NOT NULL,etag TEXT NOT NULL,PRIMARY KEY(connector_id,remote_id));",
  );
  const owner = (req, res, next) =>
    req.user.role === "owner"
      ? next()
      : res.status(403).json({ error: "Workspace owner access required." });
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof z.ZodError)
        return res.status(400).json({
          error:
            "Invalid connector settings. Check required fields and identifiers.",
        });
      next(e);
    }
  };
  const schema = z.discriminatedUnion("provider", [
    z.object({
      provider: z.literal("microsoft"),
      name: z.string().trim().min(1).max(100),
      tenantId: z.string().uuid(),
      clientId: z.string().uuid(),
      clientSecret: z.string().min(1).max(4096),
      driveId: safeId,
      folderId: safeId,
      matterId: z.string().uuid(),
      recursive: z.boolean().default(false),
    }),
    z.object({
      provider: z.literal("google"),
      name: z.string().trim().min(1).max(100),
      clientId: z.string().min(1).max(500),
      clientSecret: z.string().min(1).max(4096),
      refreshToken: z.string().min(1).max(4096),
      folderId: safeId,
      matterId: z.string().uuid(),
      recursive: z.boolean().default(false),
    }),
  ]);
  const get = (id) =>
    db
      .prepare("SELECT * FROM connectors WHERE id=? AND workspace_id=?")
      .get(id, context.getStore().workspaceId);
  app.get("/api/connectors", (req, res) => {
    if (req.user.role !== "owner")
      return res.status(403).json({ error: "Owner access required." });
    res.json(
      db
        .prepare("SELECT * FROM connectors WHERE workspace_id=?")
        .all(req.user.workspace_id)
        .map((c) => ({
          id: c.id,
          name: c.name,
          provider: c.provider,
          last_sync: c.last_sync,
          status: c.status,
          matterId: open(c.config).matterId,
        })),
    );
  });
  app.post(
    "/api/connectors",
    owner,
    wrap(async (req, res) => {
      const config = schema.parse(req.body);
      if (
        !context.getStore().state.matters.some((m) => m.id === config.matterId)
      )
        return res.status(404).json({ error: "Matter not found." });
      const id = randomUUID();
      db.prepare("INSERT INTO connectors VALUES(?,?,?,?,?,NULL,?)").run(
        id,
        req.user.workspace_id,
        config.name,
        config.provider,
        seal(config),
        "Not synced",
      );
      security.audit(
        req.user.workspace_id,
        req.user.id,
        "connector.created",
        id,
      );
      res.json({ id });
    }),
  );
  app.delete("/api/connectors/:id", owner, (req, res) => {
    const c = get(req.params.id);
    if (!c) return res.status(404).json({ error: "Connector not found." });
    db.prepare("DELETE FROM connectors WHERE id=?").run(c.id);
    security.audit(
      req.user.workspace_id,
      req.user.id,
      "connector.disconnected",
      c.id,
    );
    res.json({ ok: true });
  });
  app.post("/api/connectors/:id/sync", owner, (req, res, next) => {
    const c = get(req.params.id);
    if (!c) return res.status(404).json({ error: "Connector not found." });
    req.body = { connectorId: c.id, matterId: open(c.config).matterId };
    enqueue(req, res, next, "connector-sync");
  });
  async function bounded(
    url,
    init = {},
    limit = 20 * 1024 * 1024,
    attempt = 0,
  ) {
    const response = await fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(30000),
      redirect: "manual",
    });
    if (
      [429, 503].includes(response.status) &&
      attempt < 3 &&
      (!init.method || init.method === "GET" || String(url).includes("/token"))
    ) {
      const raw = response.headers.get("retry-after");
      const seconds = raw
        ? /^\d+$/.test(raw)
          ? Number(raw)
          : Math.max(0, (Date.parse(raw) - Date.now()) / 1000)
        : 2 ** attempt;
      if (!Number.isFinite(seconds) || seconds > 30)
        throw Error(
          "Provider requested a longer retry delay. Retry the sync later.",
        );
      await response.body?.cancel();
      await (options.wait || ((ms) => new Promise((r) => setTimeout(r, ms))))(
        Math.max(250, seconds * 1000),
      );
      return bounded(url, init, limit, attempt + 1);
    }
    if (response.status === 429) throw Error("Provider rate limit reached");
    if (!response.ok && response.status !== 302)
      throw Error("Connector provider rejected the request");
    if (Number(response.headers.get("content-length")) > limit)
      throw Error("Provider file is too large");
    if (response.status === 302)
      return { redirect: response.headers.get("location") };
    const reader = response.body.getReader(),
      parts = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) throw Error("Provider response is too large");
        parts.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { buffer: Buffer.concat(parts) };
  }
  const json = async (url, init) =>
    JSON.parse((await bounded(url, init, 2 * 1024 * 1024)).buffer.toString());
  async function accessToken(c) {
    let url, body;
    if (c.provider === "microsoft") {
      url = `https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`;
      body = new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      });
    } else {
      url = "https://oauth2.googleapis.com/token";
      body = new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: c.refreshToken,
        grant_type: "refresh_token",
      });
    }
    const data = await json(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (typeof data.access_token !== "string")
      throw Error("Provider token unavailable");
    return data.access_token;
  }
  async function list(c, token) {
    return require("./connector-list").collectFiles(c, (url) =>
      json(url, { headers: { Authorization: "Bearer " + token } }),
    );
  }
  async function download(c, file, token) {
    let url =
      c.provider === "microsoft"
        ? `${graphOrigin}/v1.0/drives/${encodeURIComponent(c.driveId)}/items/${encodeURIComponent(file.id)}/content`
        : file.nativeDoc
          ? `${googleOrigin}/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=application%2Fvnd.openxmlformats-officedocument.wordprocessingml.document`
          : `${googleOrigin}/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;
    let result = await bounded(url, {
      headers: { Authorization: "Bearer " + token },
    });
    for (let i = 0; result.redirect && i < 3; i++) {
      const target = new URL(result.redirect);
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        !["sharepoint.com", "1drv.com"].some((s) =>
          target.hostname.endsWith("." + s),
        )
      )
        throw Error("Provider download host is not permitted");
      result = await bounded(target.href);
    }
    if (!result.buffer) throw Error("Provider download redirect limit reached");
    return result.buffer;
  }
  async function sync(payload) {
    if (context.getStore().role !== "owner")
      throw Error("Owner access required");
    const row = get(payload.connectorId);
    if (!row) throw Error("Connector removed");
    const c = open(row.config);
    if (
      c.matterId !== payload.matterId ||
      !context.getStore().state.matters.some((m) => m.id === c.matterId)
    )
      throw Error("Matter access denied");
    db.prepare("UPDATE connectors SET status=? WHERE id=?").run(
      "Syncing",
      row.id,
    );
    try {
      const token = await accessToken(c),
        listing = await list(c, token);
      let imported = 0,
        updated = 0,
        skipped = 0;
      for (const file of listing.files) {
        const ext = path.extname(file.name).toLowerCase();
        if (
          ![".pdf", ".docx", ".txt", ".md", ".csv"].includes(ext) ||
          file.size > 20 * 1024 * 1024
        ) {
          skipped++;
          continue;
        }
        const known = db
          .prepare(
            "SELECT * FROM connector_items WHERE connector_id=? AND remote_id=?",
          )
          .get(row.id, file.id);
        if (known && known.etag === file.etag) {
          skipped++;
          continue;
        }
        const text = await parseDocument(await download(c, file, token), ext);
        if (!text.trim()) {
          skipped++;
          continue;
        }
        const s = context.getStore().state;
        const previous =
          known && s.documents.find((d) => d.id === known.document_id);
        const doc = {
          id: randomUUID(),
          matterId: c.matterId,
          name: file.name,
          text,
          created: new Date().toISOString(),
          source: {
            connectorId: row.id,
            remoteId: file.id,
            version: file.etag,
          },
          supersedes: previous?.id,
        };
        if (s.documents.length >= 1000)
          throw Error("Workspace document limit reached");
        if (
          s.documents.reduce((n, d) => n + d.text.length, 0) + text.length >
          25000000
        )
          throw Error("Workspace text capacity reached");
        if (previous) previous.supersededBy = doc.id;
        s.documents.push(doc);
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(
            "INSERT OR REPLACE INTO connector_items VALUES(?,?,?,?)",
          ).run(row.id, file.id, doc.id, file.etag);
          save();
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        previous ? updated++ : imported++;
      }
      const result = { imported, updated, skipped, hasMore: listing.hasMore };
      db.prepare("UPDATE connectors SET status=?,last_sync=? WHERE id=?").run(
        listing.hasMore ? "Partial: traversal budget exceeded" : "Synced",
        new Date().toISOString(),
        row.id,
      );
      security.audit(
        context.getStore().workspaceId,
        context.getStore().actor,
        "connector.synced",
        row.id,
      );
      return result;
    } catch (e) {
      db.prepare("UPDATE connectors SET status=? WHERE id=?").run(
        "Failed: check credentials, permissions and source files",
        row.id,
      );
      throw e;
    }
  }
  // Deliberate writeback: create a NEW DOCX in the configured folder, never overwrite a source file.
  app.post(
    "/api/connectors/:id/export",
    owner,
    wrap(async (req, res) => {
      const b = z
        .object({
          draftId: z.string().uuid(),
          filename: z.string().regex(/^[a-zA-Z0-9 _.-]{1,120}\.docx$/),
        })
        .parse(req.body);
      const row = get(req.params.id);
      if (!row) return res.status(404).json({ error: "Connector not found." });
      const c = open(row.config),
        draft = context
          .getStore()
          .state.drafts.find(
            (d) => d.id === b.draftId && d.matterId === c.matterId,
          );
      if (!draft)
        return res
          .status(404)
          .json({ error: "Draft not found in this connector matter." });
      const buffer = await require("./rich-text").buildDocx(draft);
      const token = await accessToken(c);
      let remote;
      if (c.provider === "microsoft") {
        const url = `${graphOrigin}/v1.0/drives/${encodeURIComponent(c.driveId)}/items/${encodeURIComponent(c.folderId)}:/${encodeURIComponent(b.filename)}:/content?@microsoft.graph.conflictBehavior=fail`;
        remote = await json(url, {
          method: "PUT",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "If-None-Match": "*",
          },
          body: buffer,
        });
      } else {
        const boundary = "counsel_" + randomUUID();
        const metadata = JSON.stringify({
          name: b.filename,
          parents: [c.folderId],
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
        const body = Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`,
          ),
          buffer,
          Buffer.from(`\r\n--${boundary}--`),
        ]);
        remote = await json(
          googleOrigin + "/upload/drive/v3/files?uploadType=multipart",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + token,
              "Content-Type": "multipart/related; boundary=" + boundary,
            },
            body,
          },
        );
      }
      security.audit(
        req.user.workspace_id,
        req.user.id,
        "connector.draft.exported",
        row.id,
      );
      res.json({ id: remote.id });
    }),
  );
  return { sync };
}
module.exports = { createConnectors };
