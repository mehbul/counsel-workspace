const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateDelta, buildDocx } = require("../rich-text");
const mammoth = require("mammoth");
test("rich text DOCX preserves emphasis headings and lists", async () => {
  const buffer = await buildDocx({
    title: "Memo",
    richContent: [
      { insert: "Important", attributes: { bold: true, italic: true } },
      { insert: "\n", attributes: { header: 2 } },
      { insert: "One" },
      { insert: "\n", attributes: { list: "bullet" } },
      { insert: "Two" },
      { insert: "\n", attributes: { list: "ordered" } },
    ],
  });
  const { value } = await mammoth.convertToHtml({ buffer });
  assert.match(value, /<h2><strong><em>Important/);
  assert.match(value, /<ul><li>One/);
  assert.match(value, /<ol><li>Two/);
});
test("shared content rejects embeds unsafe attributes and unbounded indent", () => {
  for (const op of [
    { insert: { image: "https://evil.test" } },
    { insert: "x", attributes: { link: "javascript:alert(1)" } },
    { insert: "x", attributes: { indent: 99 } },
  ])
    assert.throws(() => validateDelta([op]));
});
