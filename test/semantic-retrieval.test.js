const { test } = require("node:test");
const assert = require("node:assert/strict");
const { search, coverage, chunks } = require("../semantic-retrieval");
test("default retrieval never calls a model and exposes incomplete source coverage", async () => {
  const docs = [
    { id: "a", text: "Governing law is England.\n\nOther terms apply." },
  ];
  const result = await search("governing law", docs, {
    env: {},
    fetch: () => {
      throw Error("unexpected network");
    },
  });
  assert.equal(result.method, "lexical");
  assert.equal(result.coverage[0].complete, false);
  assert.equal(result.coverage[0].retrievedParagraphs, 1);
});
test("semantic candidates retain exact source offsets and retrieve a paraphrase", async () => {
  const docs = [
    {
      id: "a",
      text: "Either signatory may end the arrangement by writing to its counterparty.",
    },
    { id: "old", supersededBy: "a", text: "Old terms." },
  ];
  const result = await search("termination", docs, {
    env: { COUNSEL_RETRIEVAL: "hybrid", COUNSEL_EMBEDDING_MODEL: "fixture" },
    fetch: async (url, init) => {
      assert.equal(JSON.parse(init.body).input.length, 2);
      return Response.json({
        embeddings: [
          [1, 0],
          [1, 0.1],
        ],
      });
    },
  });
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].documentId, "a");
  const c = result.citations[0];
  assert.equal(docs[0].text.slice(c.startOffset, c.endOffset), c.text);
  assert.equal(result.coverage[0].complete, true);
});
test("coverage merges overlapping evidence without inflating completeness", () => {
  const d = { id: "a", text: "abcdefghijklmnop" };
  const r = coverage(
    [d],
    [
      { documentId: "a", paragraph: 1, startOffset: 0, endOffset: 10 },
      { documentId: "a", paragraph: 1, startOffset: 5, endOffset: 12 },
    ],
  );
  assert.equal(r[0].quotedCharacters, 12);
  assert.equal(r[0].complete, false);
});
test("bad embeddings fail explicitly and oversized corpora are not silently truncated", async () => {
  const opts = {
    env: { COUNSEL_RETRIEVAL: "hybrid", COUNSEL_EMBEDDING_MODEL: "fixture" },
    fetch: async () =>
      Response.json({
        embeddings: [
          [0, 0],
          [1, 2],
        ],
      }),
  };
  await assert.rejects(
    search("term", [{ id: "a", text: "text" }], opts),
    /invalid vectors/,
  );
  const docs = [{ id: "a", text: "x".repeat(800000) }];
  assert.ok(chunks(docs).length > 512);
  await assert.rejects(search("term", docs, opts), /512/);
});
