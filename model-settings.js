const fs = require("node:fs");
const path = require("node:path");
const {
  randomBytes,
  createCipheriv,
  createDecipheriv,
} = require("node:crypto");
const { lookup } = require("node:dns/promises");
const { isIP } = require("node:net");
const { z } = require("zod");
const { context } = require("./security");
const models = require("./models");
const profileSchema = z
  .object({
    provider: z.enum([
      "evidence",
      "openai",
      "anthropic",
      "openai-compatible",
      "ollama",
    ]),
    model: z.string().trim().max(200).default(""),
    baseUrl: z.string().trim().max(2000).default(""),
    apiKey: z.string().max(4096).optional(),
    clearKey: z.boolean().default(false),
    contextTokens: z.number().int().min(1024).max(1000000).default(32000),
    maxOutputTokens: z.number().int().min(64).max(32000).default(4000),
  })
  .strict();
function loopback(address) {
  return address === "::1" || /^127\./.test(address);
}
function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return (
    isIP(address) === 6 &&
    /^[23]/i.test(address) &&
    !/^2001:(?:db8|0:)/i.test(address)
  );
}
async function endpointAddresses(url, env, resolver = lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolver(host, { all: true, verbatim: true });
  const allowLocal =
    env.COUNSEL_PERSONAL === "true" || env.MODEL_ALLOW_LOOPBACK === "true";
  if (
    !addresses.length ||
    addresses.some(
      (a) => !publicAddress(a.address) && !(allowLocal && loopback(a.address)),
    )
  )
    throw Error(
      "Model endpoint must resolve to a public address. Loopback requires personal mode or MODEL_ALLOW_LOOPBACK=true.",
    );
  return addresses;
}
// Pin the checked address to the actual socket. Never follow redirects.
function safeFetch(env) {
  return async (url, init) => {
    const target = new URL(url),
      addresses = await endpointAddresses(target, env);
    const transport = require(
      target.protocol === "https:" ? "node:https" : "node:http",
    );
    return new Promise((resolve, reject) => {
      const request = transport.request(
        target,
        {
          method: init.method,
          headers: init.headers,
          signal: init.signal,
          lookup: (_host, opts, cb) =>
            opts.all
              ? cb(null, addresses)
              : cb(null, addresses[0].address, addresses[0].family),
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024)
              request.destroy(Error("Model response exceeds the size limit."));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode,
                headers: response.headers,
              }),
            ),
          );
        },
      );
      request.on("error", reject);
      request.end(init.body);
    });
  };
}
function createModelSettings(app, db, security, options = {}) {
  const env = options.env || process.env;
  const directory =
    options.dataDir || env.DATA_DIR || path.join(__dirname, "data");
  fs.mkdirSync(directory, { recursive: true });
  const keyPath = path.join(directory, "model-key");
  let key;
  try {
    const descriptor = fs.openSync(keyPath, "wx", 0o600);
    try {
      key = randomBytes(32);
      fs.writeFileSync(descriptor, key);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    key = fs.readFileSync(keyPath);
  }
  if (key.length !== 32) throw Error("Invalid model encryption key");
  db.exec(
    "CREATE TABLE IF NOT EXISTS model_settings(workspace_id TEXT PRIMARY KEY, config TEXT NOT NULL)",
  );
  function seal(profile, workspaceId) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(workspaceId));
    return Buffer.concat([
      iv,
      cipher.update(JSON.stringify(profile)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  }
  function read(workspaceId = context.getStore()?.workspaceId) {
    if (!workspaceId) return null;
    const row = db
      .prepare("SELECT config FROM model_settings WHERE workspace_id=?")
      .get(workspaceId);
    if (!row) return null;
    const data = Buffer.from(row.config, "base64"),
      cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    cipher.setAAD(Buffer.from(workspaceId));
    cipher.setAuthTag(data.subarray(-16));
    return JSON.parse(
      Buffer.concat([
        cipher.update(data.subarray(12, -16)),
        cipher.final(),
      ]).toString(),
    );
  }
  function configuration() {
    const profile = read();
    return profile
      ? models.profileConfiguration(profile)
      : models.modelConfiguration(env);
  }
  async function generate(messages, requestOptions = {}) {
    const profile = read();
    return models.generate(messages, {
      ...requestOptions,
      env,
      ...(profile
        ? {
            config: models.profileConfiguration(profile),
            fetch: options.fetch || safeFetch(env),
          }
        : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  const owner = (req, res, next) =>
    req.user?.role === "owner"
      ? next()
      : res.status(403).json({ error: "Workspace owner access required." });
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof z.ZodError || e.modelSettings)
        return res
          .status(400)
          .json({
            error:
              e instanceof z.ZodError
                ? "Invalid model settings. Check fields and token budgets."
                : e.message,
          });
      next(e);
    }
  };
  function visible(profile) {
    if (!profile) {
      const config = models.modelConfiguration(env);
      return {
        source: "server",
        provider: config.provider,
        model: config.model || "",
        contextTokens: config.contextTokens || 32000,
        maxOutputTokens: config.maxOutputTokens || 4000,
        hasKey: !!config.key,
        enabled: config.enabled,
      };
    }
    const { apiKey, clearKey, ...rest } = profile;
    return {
      ...rest,
      source: "workspace",
      hasKey: !!apiKey,
      enabled: models.profileConfiguration(profile).enabled,
    };
  }
  app.get(
    "/api/model-settings",
    owner,
    wrap(async (req, res) => res.json(visible(read(req.user.workspace_id)))),
  );
  app.put(
    "/api/model-settings",
    owner,
    wrap(async (req, res) => {
      const profile = profileSchema.parse(req.body),
        previous = read(req.user.workspace_id);
      if (profile.maxOutputTokens >= profile.contextTokens)
        throw Object.assign(
          Error("Output budget must be smaller than context budget."),
          { modelSettings: true },
        );
      if (profile.clearKey) profile.apiKey = "";
      else if (
        profile.apiKey === undefined &&
        previous?.provider === profile.provider
      )
        profile.apiKey = previous.apiKey;
      if (profile.provider !== "evidence" && !profile.model)
        throw Object.assign(Error("Choose a model name."), {
          modelSettings: true,
        });
      const config = models.profileConfiguration(profile);
      if (profile.provider !== "evidence" && !config.enabled)
        throw Object.assign(Error(config.error), { modelSettings: true });
      if (["ollama", "openai-compatible"].includes(profile.provider)) {
        try {
          await endpointAddresses(
            new URL(config.url),
            env,
            options.lookup || lookup,
          );
        } catch {
          throw Object.assign(
            Error(
              "Endpoint must use HTTPS and public network addresses; loopback requires personal mode or operator opt-in.",
            ),
            { modelSettings: true },
          );
        }
      }
      db.prepare(
        "INSERT INTO model_settings VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET config=excluded.config",
      ).run(req.user.workspace_id, seal(profile, req.user.workspace_id));
      security.audit(
        req.user.workspace_id,
        req.user.id,
        "model.settings.updated",
        profile.provider,
      );
      res.json(visible(profile));
    }),
  );
  app.delete("/api/model-settings", owner, (req, res) => {
    db.prepare("DELETE FROM model_settings WHERE workspace_id=?").run(
      req.user.workspace_id,
    );
    security.audit(
      req.user.workspace_id,
      req.user.id,
      "model.settings.reset",
      null,
    );
    res.json({ ok: true });
  });
  app.post(
    "/api/model-settings/test",
    owner,
    wrap(async (req, res) => {
      const controller = new AbortController(),
        abort = () => {
          if (!res.writableEnded) controller.abort();
        };
      res.on("close", abort);
      try {
        const result = await generate(
          [
            {
              role: "user",
              content: "Reply with OK. This is a connection test.",
            },
          ],
          { signal: controller.signal, maxOutputTokens: 64 },
        );
        security.audit(
          req.user.workspace_id,
          req.user.id,
          "model.test",
          result.provider,
        );
        res.json({
          ok: true,
          provider: result.provider,
          model: result.model,
          usage: result.usage,
          elapsedMs: result.elapsedMs,
        });
      } catch {
        res
          .status(502)
          .json({
            error:
              "Model test failed. Check configuration, endpoint availability, credentials and quota.",
          });
      } finally {
        res.off("close", abort);
      }
    }),
  );
  return { configuration, generate };
}
module.exports = { createModelSettings, endpointAddresses, publicAddress };
