const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.COUNSEL_DB = ":memory:";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "counsel-research-"),
);
process.env.AI_PROVIDER = "evidence";
// PDF parsing itself has real-file coverage. This suite exercises source trust,
// persistence and authorization without depending on a public network or parser timing.
const parser = require("../parser");
parser.parseDocument = async (bytes, extension) => {
  assert.equal(extension, ".pdf");
  return (
    "OFFICIAL PUBLICATION\n\nEffective date and scope require review.\n\n" +
    bytes.toString("utf8")
  );
};
const { app, db, jobs, workflows, research } = require("../server");

test("public research imports and publication watches remain scoped, versioned and revocable", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const nativeFetch = global.fetch;
  const published = "2026-10-20";
  const publication = (number) => ({
    document_number: number,
    title: "Synthetic publication " + number,
    publication_date: published,
    type: "Proposed Rule",
    citation: "91 FR 1234",
    effective_on: "2026-11-01",
    abstract: "Informational publication summary.",
    agencies: [{ name: "Synthetic agency" }],
    pdf_url: `https://www.govinfo.gov/content/pkg/FR-${published}/pdf/${number}.pdf`,
  });
  let list = [publication("2026-10001")],
    version = 1,
    errorOn = "",
    incomplete = false,
    gate,
    calls = [];
  function holdSource(match) {
    let enter, release, timer;
    const entered = new Promise((r, reject) => {
      timer = setTimeout(
        () => reject(Error("Expected outbound request did not start")),
        5000,
      );
      timer.unref();
      enter = () => {
        clearTimeout(timer);
        r();
      };
    });
    const wait = new Promise((r) => {
      release = r;
    });
    gate = {
      match,
      enter,
      wait,
      release: () => {
        clearTimeout(timer);
        release();
      },
    };
    return {
      entered,
      release() {
        gate = null;
        clearTimeout(timer);
        release();
      },
    };
  }
  global.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === origin) return nativeFetch(input, init);
    assert.ok(
      ["https://www.federalregister.gov", "https://www.govinfo.gov"].includes(
        url.origin,
      ),
      "No unapproved external origin may be requested",
    );
    calls.push(url.href);
    if (gate?.match(url)) {
      const waiting = gate;
      waiting.enter();
      await waiting.wait;
    }
    if (errorOn && url.pathname.includes(errorOn))
      throw Error("sensitive-provider-error-must-not-leak");
    if (url.pathname === "/api/v1/documents.json") {
      const broad =
        incomplete || url.searchParams.get("conditions[term]") === "too broad";
      return Response.json({
        count: broad ? 101 : list.length,
        results: list,
        next_page_url: broad ? "https://evil.test/not-followed" : null,
      });
    }
    if (/^\/api\/v1\/documents\/2026-\d+\.json$/.test(url.pathname))
      return Response.json(
        publication(url.pathname.split("/").at(-1).replace(".json", "")),
      );
    if (
      /^\/content\/pkg\/FR-2026-10-20\/pdf\/2026-\d+\.pdf$/.test(url.pathname)
    )
      return new Response(
        Buffer.from(
          `%PDF-1.7\nSynthetic edition ${version} for ${url.pathname}`,
        ),
      );
    throw Error("Unexpected public source path: " + url.pathname);
  };
  function client() {
    return {
      cookie: "",
      csrf: "",
      async req(p, b, method = b ? "POST" : "GET") {
        const response = await fetch(origin + "/api/" + p, {
          method,
          headers: {
            Cookie: this.cookie,
            "X-CSRF-Token": this.csrf,
            "Content-Type": "application/json",
          },
          body: b ? JSON.stringify(b) : undefined,
        });
        if (response.headers.get("set-cookie"))
          this.cookie = response.headers.get("set-cookie").split(";")[0];
        const data = response.headers
          .get("content-type")
          ?.includes("application/json")
          ? await response.json()
          : await response.text();
        if (data.csrf) this.csrf = data.csrf;
        return { status: response.status, data };
      },
    };
  }
  const owner = client(),
    editor = client(),
    viewer = client(),
    guest = client();
  let matterId, hiddenId, members, imported, watch;
  const searchPath = (mid = matterId, query = "privacy") =>
    "research/search?" +
    new URLSearchParams({
      matterId: mid,
      query,
      from: "2026-10-01",
      to: "2026-10-25",
    });
  const access = (userId, allowed) =>
    owner.req("admin/access", { userId, matterId, allowed });
  const snapshotWatch = (id) =>
    db.prepare("SELECT * FROM research_watches WHERE id=?").get(id);
  try {
    assert.equal(
      (
        await owner.req("auth/setup", {
          token: fs.readFileSync(
            path.join(process.env.DATA_DIR, "bootstrap-token"),
            "utf8",
          ),
          email: "owner@research.test",
          password: "Research owner test passphrase",
          workspace: "Research verification",
        })
      ).status,
      200,
    );
    matterId = (await owner.req("matters", { name: "Research matter" })).data
      .id;
    hiddenId = (await owner.req("matters", { name: "Restricted matter" })).data
      .id;
    for (const [role, c] of [
      ["editor", editor],
      ["viewer", viewer],
      ["guest", guest],
    ]) {
      assert.equal(
        (
          await owner.req("admin/users", {
            email: `${role}@research.test`,
            password: "Research member test passphrase",
            role,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await c.req("auth/login", {
            email: `${role}@research.test`,
            password: "Research member test passphrase",
          })
        ).status,
        200,
      );
    }
    members = Object.fromEntries(
      (await owner.req("admin/users")).data.map((u) => [u.role, u.id]),
    );
    for (const role of ["editor", "viewer", "guest"])
      await access(members[role], true);

    await t.test(
      "search requires current matter access; viewers can read and guests cannot research",
      async () => {
        const result = await editor.req(searchPath());
        assert.equal(result.status, 200);
        assert.equal(result.data.provider, "federal-register");
        assert.equal(result.data.results[0].documentNumber, "2026-10001");
        assert.equal((await viewer.req(searchPath())).status, 200);
        const before = calls.length;
        assert.equal((await editor.req(searchPath(hiddenId))).status, 404);
        assert.equal((await guest.req(searchPath())).status, 403);
        assert.equal(
          (
            await viewer.req("research/import", {
              matterId,
              documentNumber: "2026-10001",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await guest.req("research/import", {
              matterId,
              documentNumber: "2026-10001",
            })
          ).status,
          403,
        );
        assert.equal(calls.length, before);
      },
    );

    await t.test(
      "official PDF imports are idempotent by bytes and preserve prior versions and provenance",
      async () => {
        const body = { matterId, documentNumber: "2026-10001" };
        const first = await editor.req("research/import", body);
        assert.equal(first.status, 200);
        assert.equal(first.data.skipped, false);
        imported = first.data;
        assert.match(imported.source.sha256, /^[a-f0-9]{64}$/);
        assert.equal(imported.source.documentNumber, body.documentNumber);
        assert.match(imported.source.rendition, /official PDF/);
        assert.match(imported.source.legalStatus, /not verified/);
        const repeated = await editor.req("research/import", body);
        assert.deepEqual(repeated.data, { id: imported.id, skipped: true });
        version = 2;
        const updated = await editor.req("research/import", body);
        assert.equal(updated.data.skipped, false);
        assert.notEqual(updated.data.id, imported.id);
        assert.notEqual(updated.data.source.sha256, imported.source.sha256);
        const documents = (await owner.req("state")).data.documents.filter(
          (d) => d.source?.provider === "federal-register",
        );
        assert.equal(documents.length, 2);
        assert.equal(
          documents.find((d) => d.id === imported.id).supersededBy,
          updated.data.id,
        );
        assert.match(
          documents.find((d) => d.id === imported.id).text,
          /edition 1/,
        );
        assert.match(
          documents.find((d) => d.id === updated.data.id).text,
          /edition 2/,
        );
      },
    );

    await t.test(
      "source failures are explicit, sanitized, and cannot create a document",
      async () => {
        const before = (await owner.req("state")).data.documents.length;
        errorOn = "/api/v1/documents/";
        const failed = await editor.req("research/import", {
          matterId,
          documentNumber: "2026-10002",
        });
        assert.equal(failed.status, 502);
        assert.match(failed.data.error, /could not be read/);
        assert.doesNotMatch(failed.data.error, /sensitive-provider/);
        errorOn = "/api/v1/documents.json";
        const search = await editor.req(searchPath());
        assert.equal(search.status, 502);
        assert.match(search.data.error, /no legal conclusion/);
        errorOn = "";
        assert.equal((await owner.req("state")).data.documents.length, before);
      },
    );

    await t.test(
      "watches baseline existing publications, deduplicate alerts, and keep read-only users from mutations",
      async () => {
        const body = {
          matterId,
          name: "Privacy publications",
          query: "privacy",
          from: "2026-10-01",
          intervalMinutes: 15,
        };
        const baseline = await editor.req("research/watches", body);
        assert.equal(baseline.status, 200);
        watch = baseline.data;
        assert.equal(watch.alerts.length, 0);
        assert.equal(watch.seen, undefined);
        assert.equal(watch.enabled, true);
        assert.ok(watch.nextScan > Date.now());
        list = [publication("2026-10002"), publication("2026-10001")];
        const first = await editor.req(`research/watches/${watch.id}/scan`, {});
        assert.equal(first.status, 200);
        assert.equal(first.data.alerts.length, 1);
        assert.equal(first.data.alerts[0].source.documentNumber, "2026-10002");
        assert.equal(
          (await editor.req(`research/watches/${watch.id}/scan`, {})).data
            .alerts.length,
          1,
        );
        const id = first.data.alerts[0].id;
        assert.equal(
          (
            await editor.req(
              `research/watches/${watch.id}/alerts/${id}`,
              { dismissed: true },
              "PATCH",
            )
          ).data.dismissed,
          true,
        );
        assert.equal((await viewer.req("research/watches")).data.length, 1);
        assert.equal(
          (await viewer.req(`research/watches/${watch.id}/scan`, {})).status,
          403,
        );
        assert.equal(
          (
            await viewer.req(
              `research/watches/${watch.id}`,
              { enabled: false },
              "PATCH",
            )
          ).status,
          403,
        );
        assert.equal((await guest.req("research/watches")).status, 403);
        const hidden = (
          await owner.req("research/watches", { ...body, matterId: hiddenId })
        ).data;
        assert.equal(
          (await editor.req("research/watches")).data.some(
            (w) => w.id === hidden.id,
          ),
          false,
        );
        assert.equal(
          (await editor.req(`research/watches/${hidden.id}/scan`, {})).status,
          404,
        );
        assert.equal(
          (
            await owner.req(
              `research/watches/${hidden.id}`,
              { enabled: false },
              "PATCH",
            )
          ).status,
          200,
        );
      },
    );

    await t.test(
      "partial scans retain their cursor and failed scans cannot report current coverage",
      async () => {
        const before = JSON.parse(snapshotWatch(watch.id).data),
          requests = calls.length;
        incomplete = true;
        const partial = await editor.req(
          `research/watches/${watch.id}/scan`,
          {},
        );
        assert.equal(partial.status, 200);
        assert.equal(partial.data.partial, true);
        assert.match(partial.data.lastError, /coverage is incomplete/);
        assert.equal(
          JSON.parse(snapshotWatch(watch.id).data).cursorDate,
          before.cursorDate,
        );
        assert.equal(calls.length - requests, 5);
        assert.equal(partial.data.alerts.length, 1);
        incomplete = false;
        errorOn = "/api/v1/documents.json";
        const failed = await editor.req(
          `research/watches/${watch.id}/scan`,
          {},
        );
        assert.equal(failed.status, 502);
        const stored = JSON.parse(snapshotWatch(watch.id).data);
        assert.match(stored.lastError, /coverage is not current/);
        assert.equal(stored.lastScanAt, partial.data.lastScanAt);
        assert.equal(stored.alerts.length, 1);
        errorOn = "";
      },
    );

    await t.test(
      "bounded baselines and date/interval validation reject misleading incomplete watches",
      async () => {
        const before = db
          .prepare("SELECT COUNT(*) n FROM research_watches")
          .get().n;
        const body = {
          matterId,
          name: "Broad publications",
          query: "too broad",
          from: "2026-10-01",
          intervalMinutes: 15,
        };
        const broad = await owner.req("research/watches", body);
        assert.equal(broad.status, 400);
        assert.match(broad.data.error, /100 publications/);
        assert.equal(
          (
            await owner.req("research/watches", {
              ...body,
              intervalMinutes: 14,
            })
          ).status,
          400,
        );
        assert.equal(
          (await owner.req("research/watches", { ...body, from: "9999-01-01" }))
            .status,
          400,
        );
        assert.equal(
          db.prepare("SELECT COUNT(*) n FROM research_watches").get().n,
          before,
        );
      },
    );

    await t.test(
      "due scheduling runs once, records source failure and disables a revoked creator",
      async () => {
        list = [publication("2026-10003"), ...list];
        db.prepare("UPDATE research_watches SET next_scan=0 WHERE id=?").run(
          watch.id,
        );
        await research.tick();
        let stored = snapshotWatch(watch.id);
        assert.equal(
          JSON.parse(stored.data).alerts.length,
          2,
          JSON.stringify(stored),
        );
        assert.ok(stored.next_scan > Date.now());
        const count = calls.length;
        await research.tick();
        assert.equal(calls.length, count);
        errorOn = "/api/v1/documents.json";
        db.prepare("UPDATE research_watches SET next_scan=0 WHERE id=?").run(
          watch.id,
        );
        await research.tick();
        stored = snapshotWatch(watch.id);
        assert.match(
          JSON.parse(stored.data).lastError,
          /Scheduled scan failed/,
        );
        assert.equal(JSON.parse(stored.data).alerts.length, 2);
        errorOn = "";
        await access(members.editor, false);
        db.prepare("UPDATE research_watches SET next_scan=0 WHERE id=?").run(
          watch.id,
        );
        const beforeRevoked = calls.length;
        await research.tick();
        assert.equal(snapshotWatch(watch.id).enabled, 0);
        assert.equal(calls.length, beforeRevoked);
        assert.equal((await editor.req("research/watches")).data.length, 0);
        assert.equal(
          (
            await owner.req(
              `research/watches/${watch.id}`,
              { enabled: true },
              "PATCH",
            )
          ).status,
          403,
        );
        await access(members.editor, true);
      },
    );

    await t.test(
      "logout during an official PDF read prevents import persistence",
      async () => {
        await access(members.editor, true);
        const before = (await owner.req("state")).data.documents.length;
        const held = holdSource(
          (url) => url.origin === "https://www.govinfo.gov",
        );
        const importing = editor.req("research/import", {
          matterId,
          documentNumber: "2026-10004",
        });
        await held.entered;
        assert.equal((await editor.req("auth/logout", {})).status, 200);
        held.release();
        assert.equal((await importing).status, 401);
        assert.equal((await owner.req("state")).data.documents.length, before);
        assert.equal(
          (
            await editor.req("auth/login", {
              email: "editor@research.test",
              password: "Research member test passphrase",
            })
          ).status,
          200,
        );
      },
    );

    await t.test(
      "role demotion during a source read prevents a formerly authorized import",
      async () => {
        const before = (await owner.req("state")).data.documents.length;
        const held = holdSource(
          (url) => url.origin === "https://www.govinfo.gov",
        );
        const importing = editor.req("research/import", {
          matterId,
          documentNumber: "2026-10007",
        });
        await held.entered;
        db.prepare("UPDATE users SET role='viewer' WHERE id=?").run(
          members.editor,
        );
        held.release();
        try {
          assert.equal((await importing).status, 403);
        } finally {
          db.prepare("UPDATE users SET role='editor' WHERE id=?").run(
            members.editor,
          );
        }
        assert.equal((await owner.req("state")).data.documents.length, before);
      },
    );

    await t.test(
      "matter revocation during outbound search and import blocks results and writes",
      async () => {
        await access(members.editor, true);
        const held = holdSource(
          (url) => url.pathname === "/api/v1/documents.json",
        );
        const searching = editor.req(searchPath());
        await held.entered;
        await access(members.editor, false);
        held.release();
        assert.equal((await searching).status, 403);
        await access(members.editor, true);
        const before = (await owner.req("state")).data.documents.length;
        const heldImport = holdSource(
          (url) => url.origin === "https://www.govinfo.gov",
        );
        const importing = editor.req("research/import", {
          matterId,
          documentNumber: "2026-10005",
        });
        await heldImport.entered;
        await access(members.editor, false);
        heldImport.release();
        assert.equal((await importing).status, 403);
        assert.equal((await owner.req("state")).data.documents.length, before);
        await access(members.editor, true);
      },
    );

    await t.test(
      "logout during a watch scan leaves stored coverage and alerts unchanged",
      async () => {
        const created = await editor.req("research/watches", {
          matterId,
          name: "Logout safety",
          query: "privacy",
          from: "2026-10-01",
          intervalMinutes: 15,
        });
        assert.equal(created.status, 200);
        const id = created.data.id,
          before = snapshotWatch(id);
        list = [publication("2026-10006"), ...list];
        const held = holdSource(
          (url) => url.pathname === "/api/v1/documents.json",
        );
        const scanning = editor.req(`research/watches/${id}/scan`, {});
        await held.entered;
        assert.equal((await editor.req("auth/logout", {})).status, 200);
        held.release();
        assert.equal((await scanning).status, 401);
        assert.deepEqual(snapshotWatch(id), before);
      },
    );
  } finally {
    if (gate) {
      const pending = gate;
      gate = null;
      pending.release();
    }
    global.fetch = nativeFetch;
    await research.close();
    await workflows.close();
    await jobs.close();
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
});
