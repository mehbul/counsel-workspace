const { randomUUID } = require("node:crypto");
const { z } = require("zod");
const { context } = require("./security");
const sources = require("./legal-sources");
const ecfr = require("./ecfr-source");
const fail = (status, message) => Object.assign(Error(message), { status });
const text = (n) => z.string().trim().min(1).max(n);
const publicationDate = z
  .string()
  .refine(sources.date, "Use a valid publication date.");
function installResearch(app, db, security, save, dependencies = {}) {
  const search = dependencies.search || sources.searchFederalRegister;
  const getDocument = dependencies.officialDocument || sources.officialDocument;
  const searchRegulations = dependencies.searchEcfr || ecfr.searchEcfr;
  const getRegulation = dependencies.ecfrDocument || ecfr.ecfrDocument;
  const parse = dependencies.parse || require("./parser").parseDocument;
  const notify = dependencies.notify || null;
  db.exec(
    "CREATE TABLE IF NOT EXISTS research_watches(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,actor TEXT NOT NULL,matter_id TEXT NOT NULL,data TEXT NOT NULL,next_scan INTEGER NOT NULL,enabled INTEGER NOT NULL)",
  );
  const c = () => context.getStore();
  const scope = (id) => {
    if (!c().state.matters.some((m) => m.id === id))
      throw fail(404, "Matter not found.");
  };
  const activeActor = (actor, workspace, matterId) => {
    const user = db
      .prepare(
        "SELECT role FROM users WHERE id=? AND workspace_id=? AND disabled=0",
      )
      .get(actor, workspace);
    return !!(
      user &&
      ["owner", "editor"].includes(user.role) &&
      (user.role === "owner" ||
        db
          .prepare(
            "SELECT 1 FROM matter_access WHERE user_id=? AND workspace_id=? AND matter_id=?",
          )
          .get(actor, workspace, matterId))
    );
  };
  const recheck = (matterId, req) => {
    if (req && !security.session(req)) throw fail(401, "Session was revoked.");
    if (!activeActor(c().actor, c().workspaceId, matterId))
      throw fail(403, "Research access was revoked.");
  };
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
  async function external(fn) {
    try {
      return await fn();
    } catch {
      throw fail(
        502,
        "The public legal source could not be read. Retry later; no legal conclusion can be drawn from this failure.",
      );
    }
  }
  const querySchema = z
    .object({
      matterId: z.string().uuid(),
      query: text(500),
      provider: z
        .enum(["federal-register", "ecfr"])
        .default("federal-register"),
      jurisdiction: z.literal("US-federal").default("US-federal"),
      title: z.coerce.number().int().min(1).max(50).optional(),
      asOf: publicationDate.optional(),
      page: z.coerce.number().int().min(1).max(50).default(1),
      from: publicationDate.optional(),
      to: publicationDate.optional(),
    })
    .strict()
    .refine(
      (b) => !b.from || !b.to || b.from <= b.to,
      "Start date must precede end date.",
    );
  app.get(
    "/api/research/search",
    wrap(async (req, res) => {
      const b = querySchema.parse(req.query);
      scope(b.matterId);
      if (
        (b.provider === "ecfr" && (b.from || b.to)) ||
        (b.provider === "federal-register" && (b.title || b.asOf))
      )
        throw fail(
          400,
          "Use publication dates for Federal Register and snapshot date/title for eCFR.",
        );
      const result = await external(() =>
        b.provider === "ecfr"
          ? searchRegulations(b.query, b)
          : search(b.query, b),
      );
      // Recheck read permission after the network wait, including read-only members.
      const session = security.session(req);
      if (
        !session ||
        !["owner", "editor", "viewer"].includes(session.role) ||
        (session.role !== "owner" &&
          !db
            .prepare(
              "SELECT 1 FROM matter_access WHERE user_id=? AND workspace_id=? AND matter_id=?",
            )
            .get(session.id, c().workspaceId, b.matterId))
      )
        throw fail(403, "Research access was revoked.");
      res.json(result);
    }),
  );
  app.post(
    "/api/research/import",
    wrap(async (req, res) => {
      const b = z
        .discriminatedUnion("provider", [
          z
            .object({
              provider: z.literal("federal-register"),
              matterId: z.string().uuid(),
              documentNumber: z
                .string()
                .refine((s) => /^\d{4}-\d{3,8}$/.test(s)),
            })
            .strict(),
          z
            .object({
              provider: z.literal("ecfr"),
              matterId: z.string().uuid(),
              title: z.number().int().min(1).max(50),
              section: z.string().regex(/^\d{1,6}\.\d{1,6}[a-zA-Z0-9-]{0,12}$/),
              asOf: publicationDate,
            })
            .strict(),
        ])
        .parse({ provider: "federal-register", ...req.body });
      scope(b.matterId);
      recheck(b.matterId);
      const result = await external(() =>
        b.provider === "ecfr"
          ? getRegulation(b.title, b.section, b.asOf)
          : getDocument(b.documentNumber),
      );
      const sourceNumber = result.source.documentNumber;
      const existing = c().state.documents.find(
        (d) =>
          d.matterId === b.matterId &&
          d.source?.provider === b.provider &&
          d.source.documentNumber === sourceNumber &&
          d.source.sha256 === result.sha256,
      );
      if (existing) {
        recheck(b.matterId, req);
        return res.json({ id: existing.id, skipped: true });
      }
      if (c().fullState.documents.length >= 1000)
        throw fail(429, "Workspace document limit reached.");
      const extracted =
        result.text ?? (await external(() => parse(result.pdf, ".pdf")));
      recheck(b.matterId, req);
      if (!extracted.trim())
        throw fail(
          422,
          "No text could be extracted. This PDF may require OCR.",
        );
      const id = randomUUID(),
        previous = c().state.documents.filter(
          (d) =>
            d.matterId === b.matterId &&
            d.source?.provider === b.provider &&
            d.source.documentNumber === sourceNumber &&
            !d.supersededBy,
        );
      for (const d of previous) d.supersededBy = id;
      const document = {
        id,
        matterId: b.matterId,
        name: `${result.source.citation || sourceNumber} — ${result.source.title}`.slice(
          0,
          250,
        ),
        text: extracted,
        created: new Date().toISOString(),
        source: {
          provider: b.provider,
          ...result.source,
          sha256: result.sha256,
          retrievedAt: new Date().toISOString(),
          rendition:
            b.provider === "ecfr"
              ? "Plain text extracted from dated eCFR section XML; inspect original XML for structure"
              : "Text extracted from linked official PDF",
          notice: result.notice,
          legalStatus: "Current force and subsequent treatment not verified",
        },
      };
      c().state.documents.push(document);
      if (dependencies.retainOriginal) {
        try {
          document.original = dependencies.retainOriginal(
            id,
            result.original || result.pdf,
            result.mime || "application/pdf",
          );
        } catch (error) {
          c().state.documents.splice(c().state.documents.indexOf(document), 1);
          for (const d of previous) delete d.supersededBy;
          throw error;
        }
      }
      save();
      security.audit(
        c().workspaceId,
        c().actor,
        "research.document.imported",
        id,
      );
      res.json({ id, skipped: false, source: document.source });
    }),
  );
  const getWatch = (id) => {
    const row = db
      .prepare("SELECT * FROM research_watches WHERE id=? AND workspace_id=?")
      .get(id, c().workspaceId);
    if (!row) throw fail(404, "Publication watch not found.");
    scope(row.matter_id);
    return row;
  };
  const put = (row, data, enabled = row.enabled) =>
    db
      .prepare(
        "UPDATE research_watches SET data=?,next_scan=?,enabled=? WHERE id=? AND workspace_id=?",
      )
      .run(
        JSON.stringify(data),
        Date.now() + data.intervalMinutes * 60000,
        Number(!!enabled),
        row.id,
        row.workspace_id,
      );
  const metadata = (row) => {
    const d = JSON.parse(row.data);
    return {
      id: row.id,
      matterId: row.matter_id,
      ...d,
      seen: undefined,
      enabled: !!row.enabled,
      nextScan: row.next_scan,
    };
  };
  app.get("/api/research/watches", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT * FROM research_watches WHERE workspace_id=? ORDER BY rowid DESC LIMIT 50",
        )
        .all(c().workspaceId)
        .filter((r) => c().state.matters.some((m) => m.id === r.matter_id))
        .map(metadata),
    ),
  );
  async function scanPages(query, from) {
    const result = [];
    let page = 1,
      partial = false;
    do {
      const response = await search(query, { from, page });
      result.push(...response.results);
      partial = !!response.nextPage;
      page = response.nextPage;
    } while (page && page <= 5);
    return { results: result, partial };
  }
  app.post(
    "/api/research/watches",
    wrap(async (req, res) => {
      const b = z
        .object({
          matterId: z.string().uuid(),
          name: text(150),
          query: text(500),
          from: publicationDate,
          intervalMinutes: z.number().int().min(15).max(1440).default(60),
        })
        .strict()
        .parse(req.body);
      scope(b.matterId);
      recheck(b.matterId);
      if (b.from > new Date().toISOString().slice(0, 10))
        throw fail(400, "Watch start date cannot be in the future.");
      if (
        db
          .prepare(
            "SELECT COUNT(*) n FROM research_watches WHERE workspace_id=?",
          )
          .get(c().workspaceId).n >= 50
      )
        throw fail(429, "Workspace watch limit reached.");
      const baseline = await external(() => scanPages(b.query, b.from));
      recheck(b.matterId, req);
      if (baseline.partial)
        throw fail(
          400,
          "More than 100 publications matched. Narrow the query or choose a later start date.",
        );
      const id = randomUUID(),
        now = new Date().toISOString(),
        data = {
          ...b,
          created: now,
          lastScanAt: now,
          cursorDate: b.from,
          intervalMinutes: b.intervalMinutes,
          seen: [...new Set(baseline.results.map((d) => d.documentNumber))],
          alerts: [],
          lastError: null,
          partial: false,
        };
      db.prepare("INSERT INTO research_watches VALUES(?,?,?,?,?,?,1)").run(
        id,
        c().workspaceId,
        c().actor,
        b.matterId,
        JSON.stringify(data),
        Date.now() + b.intervalMinutes * 60000,
      );
      security.audit(c().workspaceId, c().actor, "research.watch.created", id);
      res.json(metadata(getWatch(id)));
    }),
  );
  async function scan(row, req) {
    const d = JSON.parse(row.data);
    scope(row.matter_id);
    if (!activeActor(row.actor, row.workspace_id, row.matter_id))
      throw fail(
        403,
        "The watch creator no longer has matter access. Disable this watch and create one under an authorized account.",
      );
    const found = await scanPages(d.query, d.cursorDate || d.from);
    recheck(row.matter_id, req);
    if (!activeActor(row.actor, row.workspace_id, row.matter_id))
      throw fail(403, "The watch creator's access was revoked.");
    const seen = new Set(d.seen),
      now = new Date().toISOString(),
      added = [];
    for (const source of found.results) {
      if (!seen.has(source.documentNumber)) {
        const alert = {
          id: randomUUID(),
          source,
          detectedAt: now,
          dismissed: false,
        };
        d.alerts.unshift(alert);
        added.push(alert);
      }
      seen.add(source.documentNumber);
    }
    d.alerts = d.alerts.slice(0, 200);
    d.seen = [...seen].slice(-2000);
    d.lastScanAt = now;
    d.partial = found.partial;
    d.lastError = found.partial
      ? "Only the first 100 matching publications were scanned. Narrow this watch; coverage is incomplete."
      : null;
    if (!found.partial)
      d.cursorDate =
        new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10) > d.from
          ? new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
          : d.from;
    put(row, d);
    if (added.length && notify) {
      const matter = c().state.matters.find((m) => m.id === row.matter_id);
      notify({
        event: "monitor.alert",
        title: `Publication watch: ${d.query}`,
        text: `${added.length} new publication${added.length === 1 ? "" : "s"} matched this watch for ${matter?.name || "a matter"}.${found.partial ? " Only the first 100 matching publications were scanned." : ""}`,
        matterId: row.matter_id,
        resourceId: row.id,
        link: "/",
        key: `monitor:${row.id}:${added[0].id}`,
      });
    }
    security.audit(
      c().workspaceId,
      c().actor,
      "research.watch.scanned",
      row.id,
    );
    return metadata(getWatch(row.id));
  }
  app.post(
    "/api/research/watches/:id/scan",
    wrap(async (req, res) => {
      const row = getWatch(req.params.id);
      recheck(row.matter_id);
      try {
        res.json(await scan(row, req));
      } catch (e) {
        if (e.status === 401 || e.status === 403) throw e;
        recheck(row.matter_id, req);
        const d = JSON.parse(row.data);
        d.lastError = "Public source scan failed; coverage is not current.";
        put(row, d);
        if (e.status) throw e;
        throw fail(502, d.lastError);
      }
    }),
  );
  app.patch(
    "/api/research/watches/:id",
    wrap(async (req, res) => {
      const b = z.object({ enabled: z.boolean() }).strict().parse(req.body),
        row = getWatch(req.params.id);
      recheck(row.matter_id);
      if (b.enabled && !activeActor(row.actor, row.workspace_id, row.matter_id))
        throw fail(
          403,
          "Watch creator no longer has access. Create a new watch.",
        );
      put(row, JSON.parse(row.data), b.enabled);
      security.audit(
        c().workspaceId,
        c().actor,
        b.enabled ? "research.watch.resumed" : "research.watch.paused",
        row.id,
      );
      res.json(metadata(getWatch(row.id)));
    }),
  );
  app.patch(
    "/api/research/watches/:id/alerts/:alertId",
    wrap(async (req, res) => {
      const row = getWatch(req.params.id);
      recheck(row.matter_id);
      const d = JSON.parse(row.data),
        alert = d.alerts.find((a) => a.id === req.params.alertId);
      if (!alert) throw fail(404, "Alert not found.");
      const b = z.object({ dismissed: z.boolean() }).strict().parse(req.body);
      alert.dismissed = b.dismissed;
      db.prepare(
        "UPDATE research_watches SET data=? WHERE id=? AND workspace_id=?",
      ).run(JSON.stringify(d), row.id, c().workspaceId);
      security.audit(
        c().workspaceId,
        c().actor,
        b.dismissed ? "research.alert.dismissed" : "research.alert.reopened",
        alert.id,
      );
      res.json(alert);
    }),
  );
  let stopped = false,
    running = false;
  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const rows = db
        .prepare(
          "SELECT * FROM research_watches WHERE enabled=1 AND next_scan<=? ORDER BY next_scan LIMIT 5",
        )
        .all(Date.now());
      for (const row of rows) {
        if (stopped) break;
        try {
          await security.runWorkspace(row.actor, row.workspace_id, async () => {
            const current = getWatch(row.id);
            if (current.enabled) await scan(current);
          });
        } catch {
          const current = db
            .prepare("SELECT * FROM research_watches WHERE id=?")
            .get(row.id);
          if (!current) continue;
          const d = JSON.parse(current.data);
          d.lastError =
            "Scheduled scan failed or creator access was revoked. Inspect permissions and run a manual scan.";
          put(
            current,
            d,
            activeActor(row.actor, row.workspace_id, row.matter_id) &&
              current.enabled,
          );
        }
      }
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => tick().catch(() => {}), 60000);
  timer.unref();
  return {
    tick,
    async close() {
      stopped = true;
      clearInterval(timer);
      while (running) await new Promise((r) => setTimeout(r, 20));
    },
  };
}
module.exports = { installResearch };
