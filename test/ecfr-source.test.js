const { test } = require("node:test");
const assert = require("node:assert/strict");
const { searchEcfr, ecfrDocument } = require("../ecfr-source");
const titles = {
  titles: [
    {
      number: 6,
      name: "Domestic Security",
      up_to_date_as_of: "2026-10-22",
      reserved: false,
    },
  ],
};
const section = {
  type: "Section",
  hierarchy: { title: "6", section: "1002.3" },
  headings: { section: "<strong>Privacy</strong> Act requests." },
  full_text_excerpt: "<strong>Privacy</strong> &amp; records",
  starts_on: "2016-12-22",
  reserved: false,
  removed: false,
};
test("eCFR search pins official origin and source date, validates filters, and omits unsupported results explicitly", async () => {
  const calls = [];
  const result = await searchEcfr("privacy & query=evil", {
    title: 6,
    fetch: async (url, init) => {
      calls.push(url);
      const u = new URL(url);
      assert.equal(u.origin, "https://www.ecfr.gov");
      assert.equal(init.redirect, "error");
      if (u.pathname.endsWith("titles.json")) return Response.json(titles);
      assert.equal(u.searchParams.get("query"), "privacy & query=evil");
      assert.equal(u.searchParams.get("date"), "2026-10-22");
      assert.equal(u.searchParams.get("hierarchy[title]"), "6");
      return Response.json({
        results: [section, { ...section, type: "Appendix" }],
        meta: { total_count: 21, total_pages: 2 },
      });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.nextPage, 2);
  assert.equal(result.omittedOnPage, 1);
  assert.equal(result.results[0].title, "Privacy Act requests.");
  assert.equal(
    result.results[0].url,
    "https://www.ecfr.gov/on/2026-10-22/title-6/section-1002.3",
  );
  await assert.rejects(searchEcfr("test", { title: 51 }), /CFR title/);
  await assert.rejects(
    searchEcfr("test", {
      asOf: "2026-10-23",
      fetch: async () => Response.json(titles),
    }),
    /source availability/,
  );
});
test("eCFR import retains exact bounded XML, hashes source and rejects DTD and wrong section", async () => {
  const xml = Buffer.from(
    '<?xml version="1.0"?><DIV8 N="1002.3" TYPE="SECTION"><HEAD>§ 1002.3 Requests.</HEAD><P>(a) Read <I>all</I> evidence &amp; dates.</P></DIV8>',
  );
  const read = async (value) =>
    ecfrDocument(6, "1002.3", "2026-10-22", {
      fetch: async (url, init) => {
        assert.equal(new URL(url).origin, "https://www.ecfr.gov");
        assert.equal(init.headers.Accept, "application/xml");
        return new Response(value);
      },
    });
  const result = await read(xml);
  assert.deepEqual(result.original, xml);
  assert.match(result.text, /Read all evidence & dates/);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    read(xml.toString().replace("1002.3", "1002.4")),
    /unexpected section/,
  );
  await assert.rejects(
    read('<!DOCTYPE x [<!ENTITY private SYSTEM "file:///secret">]>' + xml),
    /unexpected section/,
  );
  await assert.rejects(ecfrDocument(6, "../secret", "2026-10-22"), /Invalid/);
  await assert.rejects(
    read(Buffer.alloc(5 * 1024 * 1024 + 1, 120)),
    /too large/,
  );
});
