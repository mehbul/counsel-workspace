const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseDocument } = require("../parser");
const { Document, Paragraph, Packer } = require("docx");
function pdf(text) {
  const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}
test("isolated process extracts real DOCX and PDF content and rejects corrupt files", async () => {
  const docx = await Packer.toBuffer(
    new Document({
      sections: [
        { children: [new Paragraph("Governing law is England and Wales.")] },
      ],
    }),
  );
  assert.match(await parseDocument(docx, ".docx"), /England and Wales/);
  assert.match(
    await parseDocument(pdf("Liability is capped at GBP 500."), ".pdf"),
    /Liability is capped/,
  );
  await assert.rejects(parseDocument(Buffer.from("not a PDF"), ".pdf"));
  await assert.rejects(parseDocument(Buffer.from("not a ZIP"), ".docx"));
});
