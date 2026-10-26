const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  searchFederalRegister,
  officialDocument,
  normalizeDocument,
  readSource,
  date,
} = require("../legal-sources");
const metadata = (overrides = {}) => ({
  document_number: "2026-10001",
  title: "Synthetic federal publication",
  publication_date: "2026-10-20",
  type: "Proposed Rule",
  effective_on: "2026-11-01",
  abstract: "A proposed publication is not proof of current legal force.",
  citation: "91 FR 10001",
  agencies: [{ name: "Synthetic agency" }],
  pdf_url:
    "https://www.govinfo.gov/content/pkg/FR-2026-10-20/pdf/2026-10001.pdf",
  ...overrides,
});

test("publication dates reject impossible calendar dates rather than normalizing them", () => {
  assert.equal(date("2024-02-29"), true);
  for (const value of [
    "2026-02-29",
    "2026-13-01",
    "2026-10-32",
    "2026-1-01",
    null,
    0,
  ])
    assert.equal(date(value), false);
});

test("source metadata derives the publication link and accepts only the exact official PDF", () => {
  const normalized = normalizeDocument(
    metadata({ html_url: "https://evil.test/", effective_on: "2026-02-30" }),
  );
  assert.equal(
    normalized.url,
    "https://www.federalregister.gov/documents/2026/10/20/2026-10001",
  );
  assert.equal(normalized.officialPdf, metadata().pdf_url);
  assert.equal(normalized.effectiveOn, null);
  assert.equal(normalized.type, "Proposed Rule");
  for (const pdf_url of [
    "http://www.govinfo.gov/content/pkg/FR-2026-10-20/pdf/2026-10001.pdf",
    "https://govinfo.gov/content/pkg/FR-2026-10-20/pdf/2026-10001.pdf",
    "https://www.govinfo.gov.evil.test/content/pkg/FR-2026-10-20/pdf/2026-10001.pdf",
    "https://user:secret@www.govinfo.gov/content/pkg/FR-2026-10-20/pdf/2026-10001.pdf",
    metadata().pdf_url + "?redirect=https://evil.test",
    metadata().pdf_url + "#fragment",
    "https://www.govinfo.gov/content/pkg/FR-2026-10-21/pdf/2026-10001.pdf",
    "https://www.govinfo.gov/content/pkg/FR-2026-10-20/pdf/2026-10002.pdf",
    "https://www.govinfo.gov/content/pkg/FR-2026-10-20/pdf/../2026-10001.pdf",
  ])
    assert.equal(normalizeDocument(metadata({ pdf_url })).officialPdf, null);
  assert.equal(
    normalizeDocument(metadata({ document_number: "../secrets" })),
    null,
  );
  assert.equal(
    normalizeDocument(metadata({ publication_date: "2026-02-30" })),
    null,
  );
});

test("queries are encoded as one search parameter and pagination ignores upstream URLs", async () => {
  const query = 'privacy & conditions[term]=evil # /? "quoted"';
  const result = await searchFederalRegister(query, {
    page: 2,
    from: "2026-01-01",
    to: "2026-10-20",
    fetch: async (url, init) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, "https://www.federalregister.gov");
      assert.equal(parsed.pathname, "/api/v1/documents.json");
      assert.equal(parsed.searchParams.getAll("conditions[term]").length, 1);
      assert.equal(parsed.searchParams.get("conditions[term]"), query);
      assert.equal(parsed.searchParams.get("page"), "2");
      assert.equal(
        parsed.searchParams.get("conditions[publication_date][gte]"),
        "2026-01-01",
      );
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      return Response.json({
        count: 30,
        next_page_url: "http://127.0.0.1/private",
        results: [metadata(), { document_number: "bad" }],
      });
    },
  });
  assert.equal(result.nextPage, 3);
  assert.equal(result.results.length, 1);
  assert.match(result.notice, /does not establish current legal force/);
});

test("invalid query, page, and date ranges fail before any external request", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    throw Error("Unexpected request");
  };
  for (const [query, options] of [
    ["", {}],
    [" ", {}],
    ["x".repeat(501), {}],
    ["privacy", { page: 0 }],
    ["privacy", { page: -1 }],
    ["privacy", { page: 51 }],
    ["privacy", { page: 1.5 }],
    ["privacy", { from: "2026-02-30" }],
    ["privacy", { from: "2026-10-20", to: "2026-01-01" }],
  ])
    await assert.rejects(searchFederalRegister(query, { ...options, fetch }));
  assert.equal(calls, 0);
});

test("bounded readers reject declared and streamed oversize responses, redirects, malformed JSON and non-PDF bodies", async () => {
  let cancelled = false;
  await assert.rejects(
    readSource("https://www.federalregister.gov/api/v1/documents.json", 10, {
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-length": "11" } },
        ),
    }),
    /too large/,
  );
  assert.equal(cancelled, true);
  await assert.rejects(
    readSource("https://www.federalregister.gov/api/v1/documents.json", 10, {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(6));
              controller.enqueue(new Uint8Array(6));
              controller.close();
            },
          }),
        ),
    }),
    /too large/,
  );
  await assert.rejects(
    readSource("https://www.federalregister.gov/api/v1/documents.json", 100, {
      fetch: async (_, init) => {
        assert.equal(init.redirect, "error");
        return new Response("", {
          status: 302,
          headers: { Location: "http://127.0.0.1/private" },
        });
      },
    }),
    /unavailable/,
  );
  await assert.rejects(
    readSource("https://www.federalregister.gov/api/v1/documents.json", 100, {
      fetch: async () => new Response("<html>Error</html>"),
    }),
    /invalid response/,
  );
  await assert.rejects(
    readSource(metadata().pdf_url, 100, {
      pdf: true,
      fetch: async () => new Response("<html>Not a PDF</html>"),
    }),
    /did not return a PDF/,
  );
});

test("official import matches the requested publication and hashes the exact PDF bytes", async () => {
  const pdf = Buffer.from(
    "%PDF-1.7\nSynthetic PDF bytes for deterministic hashing",
  );
  const calls = [];
  const result = await officialDocument("2026-10001", {
    fetch: async (url, init) => {
      calls.push(url);
      assert.equal(init.redirect, "error");
      if (
        url ===
        "https://www.federalregister.gov/api/v1/documents/2026-10001.json"
      )
        return Response.json(metadata());
      assert.equal(url, metadata().pdf_url);
      assert.equal(init.headers.Accept, "application/pdf");
      return new Response(pdf);
    },
  });
  assert.deepEqual(result.pdf, pdf);
  assert.equal(result.sha256, createHash("sha256").update(pdf).digest("hex"));
  assert.equal(calls.length, 2);
  for (const bad of [
    "../10001",
    "2026-10001?path=secret",
    "https://evil.test/",
    "2026-1",
  ]) {
    let requested = false;
    await assert.rejects(
      officialDocument(bad, {
        fetch: async () => {
          requested = true;
        },
      }),
      /Invalid/,
    );
    assert.equal(requested, false);
  }
});

test("mismatched IDs or unofficial download links never trigger a PDF fetch", async () => {
  for (const doc of [
    metadata({ document_number: "2026-10002" }),
    metadata({ pdf_url: "https://evil.test/file.pdf" }),
  ]) {
    let count = 0;
    await assert.rejects(
      officialDocument("2026-10001", {
        fetch: async () => {
          count++;
          return Response.json(doc);
        },
      }),
      /matching official PDF/,
    );
    assert.equal(count, 1);
  }
});
