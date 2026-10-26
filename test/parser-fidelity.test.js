const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseDocument,
  parseDocumentDetailed,
  ocrStatus,
} = require("../parser");

function pdfFixture(empty = false) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    "",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, content] of [
    [3, "First page clause"],
    [5, "Second page clause"],
  ]) {
    const stream = `BT /F1 12 Tf 40 700 Td (${empty ? "" : content}) Tj ET`;
    objects[index] =
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let pdf = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
test("string parser contract and honest OCR availability", async () => {
  assert.equal(
    await parseDocument(Buffer.from("Exact\nα"), ".txt"),
    "Exact\nα",
  );
  assert.equal(ocrStatus().available, false);
  assert.equal(ocrStatus().enabled, false);
});
test("PDFs without readable text report OCR need without invoking an OCR service", async () => {
  const parsed = await parseDocumentDetailed(pdfFixture(true), ".pdf");
  assert.equal(parsed.ocr.available, false);
  assert.equal(parsed.ocr.enabled, false);
  assert.equal(parsed.ocr.needed, true);
});
test("PDF anchors address exact extracted pages", async () => {
  const parsed = await parseDocumentDetailed(pdfFixture(), ".pdf");
  assert.equal(parsed.pages.length, 2);
  for (const [i, page] of parsed.pages.entries()) {
    assert.equal(page.page, i + 1);
    assert.match(
      parsed.text.slice(page.start, page.end),
      i ? /Second page clause/ : /First page clause/,
    );
  }
  assert.equal(parsed.ocr.needed, false);
});
