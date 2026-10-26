const { createHmac, randomBytes, randomUUID } = require("node:crypto");
const dns = require("node:dns").promises;
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const { z } = require("zod");
const { context } = require("./security");
const { createSecretBox } = require("./secret-box");

const EVENTS = [
  "workflow.approval_required",
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
  "monitor.alert",
];
const KINDS = ["webhook", "slack", "teams"];
const RETRY_DELAYS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
const MAX_ATTEMPTS = 5;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_URL_LENGTH = 2048;
const REQUEST_TIMEOUT_MS = 10_000;
const fail = (status, message) => Object.assign(Error(message), { status });
const text = (n) => z.string().trim().min(1).max(n);

function privateIp(address) {
  const ip = String(address || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (net.isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    if (
      parts.length !== 4 ||
      parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    )
      return true;
    if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true;
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
    if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true;
    if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true;
    if (parts[0] >= 224) return true;
    return false;
  }
  if (net.isIP(ip) === 6) {
    if (ip.startsWith("::")) return true;
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(ip)) return true;
    if (ip.startsWith("2001:db8")) return true;
    if (ip.startsWith("64:ff9b:")) return true;
    const mapped = ip.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) {
      const high = parseInt(mapped[1], 16),
        low = parseInt(mapped[2], 16);
      return privateIp([high >> 8, high & 255, low >> 8, low & 255].join("."));
    }
    return false;
  }
  return false;
}

function localHost(host) {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa") ||
    privateIp(host)
  );
}

function validateWebhookUrl(value, options = {}) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_URL_LENGTH
  )
    throw fail(400, "Enter a webhook URL of 2048 characters or fewer.");
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw fail(400, "Enter a valid absolute webhook URL.");
  }
  if (!["https:", "http:"].includes(url.protocol))
    throw fail(400, "Webhook URLs must use HTTPS.");
  if (url.username || url.password)
    throw fail(400, "Webhook URLs must not contain embedded credentials.");
  if (url.hash) throw fail(400, "Webhook URLs must not contain a fragment.");
  if (!url.hostname) throw fail(400, "Webhook URL host is missing.");
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))
    throw fail(400, "Webhook URL port is invalid.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = localHost(host);
  if (
    url.protocol === "http:" &&
    !options.allowHttp &&
    !(options.allowPrivate && local)
  )
    throw fail(
      400,
      "Webhook URLs must use HTTPS. HTTP is allowed only for private targets in local testing.",
    );
  if (!options.allowPrivate && local)
    throw fail(400, "Webhook URL must use a public host.");
  return url;
}

async function resolveTarget(url, options = {}) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw Object.assign(Error("Webhook host could not be resolved."), {
      retryable: true,
    });
  }
  if (!addresses.length)
    throw Object.assign(Error("Webhook host did not resolve."), {
      retryable: true,
    });
  if (!options.allowPrivate && addresses.some((a) => privateIp(a.address)))
    throw Object.assign(Error("Webhook host resolves to a private address."), {
      permanent: true,
    });
  const chosen = addresses.find((a) => !privateIp(a.address)) || addresses[0];
  return { url, address: chosen.address, family: chosen.family };
}

function postJson(target, body, headers, options = {}) {
  const transport = target.url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: target.url.protocol,
        hostname: target.address,
        family: target.family,
        port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
        path: target.url.pathname + target.url.search,
        method: "POST",
        servername:
          target.url.protocol === "https:"
            ? target.url.hostname.replace(/^\[|\]$/g, "")
            : undefined,
        headers: {
          Host: target.url.host,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "Counsel-Workspace/1.0 (webhook notification)",
          Connection: "close",
          ...headers,
        },
        agent: false,
        timeout: REQUEST_TIMEOUT_MS,
        rejectUnauthorized: true,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8").slice(0, 2000),
          }),
        );
      },
    );
    request.on("timeout", () =>
      request.destroy(
        Object.assign(Error("Webhook request timed out."), { retryable: true }),
      ),
    );
    request.on("error", (error) => {
      if (!error.retryable && !error.permanent) {
        const code = error.code || "";
        error.retryable = ![
          "CERT_HAS_EXPIRED",
          "DEPTH_ZERO_SELF_SIGNED_CERT",
          "ERR_TLS_CERT_ALTNAME_INVALID",
          "SELF_SIGNED_CERT_IN_CHAIN",
          "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        ].includes(code);
      }
      reject(error);
    });
    request.end(body);
  });
}

function maskedUrl(value) {
  try {
    const url = new URL(value);
    const pathname =
      url.pathname.length > 14
        ? url.pathname.slice(0, 8) + "…" + url.pathname.slice(-4)
        : url.pathname;
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return "[unreadable]";
  }
}

function safeLink(value) {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    value.length <= 500
    ? value
    : null;
}

function slackBody(payload, link) {
  return JSON.stringify({
    text: [payload.title, payload.text, link].filter(Boolean).join("\n"),
  });
}

function teamsBody(payload, link) {
  return JSON.stringify({
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: "2F5D50",
    summary: payload.title,
    title: payload.title,
    text: [payload.text, link ? `[Open Counsel](${link})` : ""]
      .filter(Boolean)
      .join("\n\n"),
  });
}

function webhookBody(payload, link) {
  return JSON.stringify({ ...payload, url: link });
}

function createNotifications(app, db, security, options = {}) {
  const allowPrivate = options.allowPrivateHosts === true;
  const allowHttp = options.allowHttp === true || allowPrivate;
  const origin = options.origin || process.env.APP_ORIGIN || "";
  const retryDelays = options.retryDelays || RETRY_DELAYS;
  const now = options.now || Date.now;
  const dataDir =
    options.dataDir || process.env.DATA_DIR || path.join(__dirname, "data");
  const { seal, open } = createSecretBox(dataDir);

  db.exec(`CREATE TABLE IF NOT EXISTS notification_channels(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT,
    events TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notification_deliveries(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    event TEXT NOT NULL,
    event_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    next_attempt INTEGER NOT NULL,
    response_status INTEGER,
    response_body TEXT,
    error TEXT,
    created TEXT NOT NULL,
    updated TEXT NOT NULL,
    delivered TEXT,
    UNIQUE(channel_id,event_key)
  );
  CREATE INDEX IF NOT EXISTS notification_due
    ON notification_deliveries(status,next_attempt);
  UPDATE notification_deliveries SET status='pending' WHERE status='sending';`);

  const c = () => context.getStore();
  const iso = () => new Date(now()).toISOString();
  const owner = (req, res, next) =>
    req.user.role === "owner"
      ? next()
      : res.status(403).json({ error: "Workspace owner access required." });
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof z.ZodError)
        return res
          .status(400)
          .json({ error: e.issues.map((i) => i.message).join("; ") });
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  };
  function channelRow(id) {
    return db
      .prepare(
        "SELECT * FROM notification_channels WHERE id=? AND workspace_id=?",
      )
      .get(id, c().workspaceId);
  }
  function describeChannel(row, includeSecret = false) {
    const result = {
      id: row.id,
      name: row.name,
      kind: row.kind,
      url: maskedUrl(open(row.url)),
      events: JSON.parse(row.events),
      enabled: !!row.enabled,
      created: row.created,
      updated: row.updated,
    };
    if (includeSecret && row.secret) result.secret = open(row.secret);
    return result;
  }
  function describeDelivery(row) {
    const payload = JSON.parse(row.payload);
    return {
      id: row.id,
      channelId: row.channel_id,
      channelName: row.channel_name || "Deleted channel",
      event: row.event,
      title: payload.title,
      text: payload.text,
      status: row.status,
      attempts: row.attempts,
      nextAttempt: row.next_attempt
        ? new Date(row.next_attempt).toISOString()
        : null,
      responseStatus: row.response_status,
      responseBody: row.response_body,
      error: row.error,
      created: row.created,
      updated: row.updated,
      delivered: row.delivered,
    };
  }

  const eventSchema = z.enum(EVENTS);
  const createSchema = z
    .object({
      name: text(100),
      kind: z.enum(KINDS),
      url: z.string().trim().min(1).max(MAX_URL_LENGTH),
      secret: z.string().trim().min(16).max(256).optional(),
      events: z.array(eventSchema).min(1).max(EVENTS.length).default(EVENTS),
      enabled: z.boolean().default(true),
    })
    .strict();
  const updateSchema = z
    .object({
      name: text(100).optional(),
      kind: z.enum(KINDS).optional(),
      url: z.string().trim().min(1).max(MAX_URL_LENGTH).optional(),
      secret: z.string().trim().min(16).max(256).optional(),
      rotateSecret: z.boolean().optional(),
      events: z.array(eventSchema).min(1).max(EVENTS.length).optional(),
      enabled: z.boolean().optional(),
    })
    .strict()
    .refine(
      (b) => Object.keys(b).length > 0,
      "Supply at least one channel change.",
    );

  app.get(
    "/api/notification-channels",
    owner,
    wrap(async (req, res) =>
      res.json(
        db
          .prepare(
            "SELECT * FROM notification_channels WHERE workspace_id=? ORDER BY created DESC",
          )
          .all(c().workspaceId)
          .map((row) => describeChannel(row)),
      ),
    ),
  );

  app.post(
    "/api/notification-channels",
    owner,
    wrap(async (req, res) => {
      const b = createSchema.parse(req.body);
      const target = validateWebhookUrl(b.url, { allowPrivate, allowHttp });
      const plainSecret =
        b.kind === "webhook"
          ? b.secret || randomBytes(24).toString("hex")
          : null;
      const id = randomUUID();
      const stamp = iso();
      db.prepare(
        "INSERT INTO notification_channels VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        c().workspaceId,
        b.name,
        b.kind,
        seal(target.href),
        plainSecret ? seal(plainSecret) : null,
        JSON.stringify([...new Set(b.events)]),
        b.enabled ? 1 : 0,
        stamp,
        stamp,
      );
      security.audit(
        c().workspaceId,
        c().actor,
        "notification.channel.created",
        id,
      );
      res.status(201).json({
        ...describeChannel(channelRow(id), true),
        ...(plainSecret ? { secret: plainSecret } : {}),
      });
    }),
  );

  app.patch(
    "/api/notification-channels/:id",
    owner,
    wrap(async (req, res) => {
      const b = updateSchema.parse(req.body);
      const current = channelRow(req.params.id);
      if (!current) throw fail(404, "Notification channel not found.");
      const kind = b.kind || current.kind;
      const url = b.url
        ? validateWebhookUrl(b.url, { allowPrivate, allowHttp }).href
        : open(current.url);
      let plainSecret = null;
      let secret = kind === "webhook" ? current.secret : null;
      if (kind === "webhook") {
        if (b.rotateSecret) plainSecret = randomBytes(24).toString("hex");
        else if (b.secret) plainSecret = b.secret;
        if (plainSecret) secret = seal(plainSecret);
        else if (!secret) plainSecret = randomBytes(24).toString("hex");
        if (!secret && plainSecret) secret = seal(plainSecret);
      }
      db.prepare(
        "UPDATE notification_channels SET name=?,kind=?,url=?,secret=?,events=?,enabled=?,updated=? WHERE id=? AND workspace_id=?",
      ).run(
        b.name || current.name,
        kind,
        seal(url),
        secret,
        JSON.stringify(
          b.events ? [...new Set(b.events)] : JSON.parse(current.events),
        ),
        b.enabled === undefined ? current.enabled : b.enabled ? 1 : 0,
        iso(),
        current.id,
        c().workspaceId,
      );
      security.audit(
        c().workspaceId,
        c().actor,
        "notification.channel.updated",
        current.id,
      );
      res.json({
        ...describeChannel(channelRow(current.id)),
        ...(plainSecret ? { secret: plainSecret } : {}),
      });
    }),
  );

  app.delete(
    "/api/notification-channels/:id",
    owner,
    wrap(async (req, res) => {
      const current = channelRow(req.params.id);
      if (!current) throw fail(404, "Notification channel not found.");
      db.prepare(
        "DELETE FROM notification_channels WHERE id=? AND workspace_id=?",
      ).run(current.id, c().workspaceId);
      security.audit(
        c().workspaceId,
        c().actor,
        "notification.channel.deleted",
        current.id,
      );
      res.json({ deleted: true });
    }),
  );

  app.get(
    "/api/notification-deliveries",
    owner,
    wrap(async (req, res) => {
      const limit = Math.min(
        100,
        Math.max(1, Number(req.query.limit || 50) || 50),
      );
      res.json(
        db
          .prepare(
            "SELECT d.*,ch.name channel_name FROM notification_deliveries d LEFT JOIN notification_channels ch ON ch.id=d.channel_id AND ch.workspace_id=d.workspace_id WHERE d.workspace_id=? ORDER BY d.created DESC LIMIT ?",
          )
          .all(c().workspaceId, limit)
          .map(describeDelivery),
      );
    }),
  );

  app.post(
    "/api/notification-channels/:id/test",
    owner,
    wrap(async (req, res) => {
      const channel = channelRow(req.params.id);
      if (!channel) throw fail(404, "Notification channel not found.");
      const ids = enqueue(
        {
          event: "test",
          title: "Counsel notification test",
          text: `This is a test delivery from ${c().state.name || "your Counsel workspace"}.`,
          link: "/",
          key: `test:${randomUUID()}`,
        },
        c().workspaceId,
        { ignoreEvents: true, channelId: channel.id },
      );
      if (!ids.length) throw fail(409, "The channel is disabled.");
      let row;
      for (let pass = 0; pass < 4; pass++) {
        await tick();
        row = db
          .prepare(
            "SELECT d.*,ch.name channel_name FROM notification_deliveries d LEFT JOIN notification_channels ch ON ch.id=d.channel_id WHERE d.id=? AND d.workspace_id=?",
          )
          .get(ids[0], c().workspaceId);
        if (
          !row ||
          row.status === "delivered" ||
          row.status === "dead" ||
          (row.status === "pending" && row.next_attempt > now())
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      security.audit(
        c().workspaceId,
        c().actor,
        "notification.channel.tested",
        channel.id,
      );
      res.json(describeDelivery(row));
    }),
  );

  app.post(
    "/api/notification-deliveries/:id/retry",
    owner,
    wrap(async (req, res) => {
      const row = db
        .prepare(
          "SELECT * FROM notification_deliveries WHERE id=? AND workspace_id=?",
        )
        .get(req.params.id, c().workspaceId);
      if (!row) throw fail(404, "Delivery not found.");
      if (!["dead", "pending"].includes(row.status))
        throw fail(409, "Only failed or pending deliveries can be retried.");
      db.prepare(
        "UPDATE notification_deliveries SET status='pending',attempts=0,next_attempt=?,error=NULL,response_status=NULL,response_body=NULL,updated=? WHERE id=? AND workspace_id=?",
      ).run(now(), iso(), row.id, c().workspaceId);
      security.audit(
        c().workspaceId,
        c().actor,
        "notification.delivery.retried",
        row.id,
      );
      res.json(describeDelivery({ ...row, status: "pending", attempts: 0 }));
    }),
  );

  function enqueue(payload, workspaceId, options = {}) {
    const ws = workspaceId || c()?.workspaceId;
    if (!ws) throw Error("Notification workspace context required");
    const channels = db
      .prepare(
        "SELECT * FROM notification_channels WHERE workspace_id=? AND enabled=1",
      )
      .all(ws)
      .filter(
        (channel) =>
          (!options.channelId || channel.id === options.channelId) &&
          (options.ignoreEvents ||
            JSON.parse(channel.events).includes(payload.event)),
      );
    const created = [];
    for (const channel of channels) {
      const id = randomUUID();
      const key = payload.key || id;
      const body = JSON.stringify({
        event: payload.event,
        title: String(payload.title || "").slice(0, 200),
        text: String(payload.text || "").slice(0, 4000),
        matterId: payload.matterId || null,
        resourceId: payload.resourceId || null,
        link: safeLink(payload.link),
        created: iso(),
      });
      const result = db
        .prepare(
          "INSERT OR IGNORE INTO notification_deliveries(id,workspace_id,channel_id,event,event_key,payload,status,attempts,next_attempt,created,updated) VALUES(?,?,?,?,?,?,'pending',0,?,?,?)",
        )
        .run(id, ws, channel.id, payload.event, key, body, now(), iso(), iso());
      if (result.changes) created.push(id);
    }
    return created;
  }

  function notify(payload, workspaceId) {
    return enqueue(payload, workspaceId);
  }

  function delayFor(attempts) {
    return retryDelays[Math.min(attempts - 1, retryDelays.length - 1)] || 0;
  }

  function settle(row, status, fields = {}) {
    db.prepare(
      "UPDATE notification_deliveries SET status=?,attempts=?,next_attempt=?,response_status=?,response_body=?,error=?,updated=?,delivered=? WHERE id=? AND workspace_id=?",
    ).run(
      status,
      fields.attempts ?? row.attempts,
      fields.nextAttempt ?? 0,
      fields.responseStatus ?? null,
      fields.responseBody ?? null,
      fields.error ?? null,
      iso(),
      status === "delivered" ? iso() : null,
      row.id,
      row.workspace_id,
    );
  }

  async function attempt(row) {
    const channel = db
      .prepare(
        "SELECT * FROM notification_channels WHERE id=? AND workspace_id=?",
      )
      .get(row.channel_id, row.workspace_id);
    if (!channel || !channel.enabled)
      return settle(row, "dead", {
        attempts: row.attempts,
        error: "Channel is disabled or removed.",
      });
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      return settle(row, "dead", {
        attempts: row.attempts,
        error: "Stored notification payload is invalid.",
      });
    }
    const attempts = row.attempts + 1;
    try {
      const url = validateWebhookUrl(open(channel.url), {
        allowPrivate,
        allowHttp,
      });
      const target = await resolveTarget(url, { allowPrivate });
      const link =
        origin && payload.link ? new URL(payload.link, origin).href : null;
      const body =
        channel.kind === "slack"
          ? slackBody(payload, link)
          : channel.kind === "teams"
            ? teamsBody(payload, link)
            : webhookBody(payload, link);
      const headers = { "X-Counsel-Event": row.event };
      if (channel.kind === "webhook" && channel.secret) {
        const timestamp = String(now());
        const signature = createHmac("sha256", open(channel.secret))
          .update(`${timestamp}.${body}`)
          .digest("hex");
        headers["X-Counsel-Timestamp"] = timestamp;
        headers["X-Counsel-Signature"] = `v1=${signature}`;
      }
      const result = await postJson(target, body, headers);
      if (result.status >= 200 && result.status < 300)
        return settle(row, "delivered", {
          attempts,
          responseStatus: result.status,
          responseBody: result.body,
        });
      const retryable =
        result.status === 408 ||
        result.status === 425 ||
        result.status === 429 ||
        result.status >= 500;
      if (retryable && attempts < MAX_ATTEMPTS)
        return settle(row, "pending", {
          attempts,
          nextAttempt: now() + delayFor(attempts),
          responseStatus: result.status,
          responseBody: result.body,
          error: `Webhook returned HTTP ${result.status}.`,
        });
      return settle(row, "dead", {
        attempts,
        responseStatus: result.status,
        responseBody: result.body,
        error:
          result.status >= 300 && result.status < 400
            ? "Webhook redirects are not followed."
            : `Webhook returned HTTP ${result.status}.`,
      });
    } catch (error) {
      const retryable = error.retryable && attempts < MAX_ATTEMPTS;
      return settle(row, retryable ? "pending" : "dead", {
        attempts,
        ...(retryable
          ? { nextAttempt: now() + delayFor(attempts) }
          : { nextAttempt: 0 }),
        error: String(error.message || "Webhook delivery failed.").slice(
          0,
          500,
        ),
      });
    }
  }

  let running = null,
    closed = false;
  function tick() {
    if (closed) return Promise.resolve();
    if (running) return running;
    const task = (async () => {
      const due = db
        .prepare(
          "SELECT * FROM notification_deliveries WHERE status='pending' AND next_attempt<=? ORDER BY next_attempt LIMIT 20",
        )
        .all(now());
      for (const row of due) {
        if (closed) break;
        const claimed = db
          .prepare(
            "UPDATE notification_deliveries SET status='sending',updated=? WHERE id=? AND status='pending'",
          )
          .run(iso(), row.id);
        if (claimed.changes) await attempt(row);
      }
    })();
    running = task;
    task.then(
      () => {
        if (running === task) running = null;
      },
      () => {
        if (running === task) running = null;
      },
    );
    return task;
  }

  const timer = setInterval(() => tick().catch(() => {}), 5000);
  timer.unref();

  return {
    notify,
    enqueue,
    tick,
    events: EVENTS,
    async close() {
      closed = true;
      clearInterval(timer);
      if (running) await running.catch(() => {});
    },
  };
}

module.exports = {
  createNotifications,
  validateWebhookUrl,
  privateIp,
  EVENTS,
};
