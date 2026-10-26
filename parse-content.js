async function extractDocument(buffer, ext) {
  let text,
    pages = [];
  if (ext === ".pdf") {
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      text = "";
      for (const page of result.pages) {
        if (text) text += "\n\n";
        const start = text.length;
        text += page.text;
        pages.push({ page: page.num, start, end: text.length });
      }
    } finally {
      await parser.destroy();
    }
  } else if (ext === ".docx")
    text = (await require("mammoth").extractRawText({ buffer })).value;
  else text = buffer.toString("utf8");
  if (text.length > 2000000)
    throw Error("Document text exceeds the supported limit.");
  return {
    text,
    pages,
    ocr: {
      available: false,
      enabled: false,
      needed: ext === ".pdf" && text.trim().length === 0,
    },
  };
}
module.exports = { extractDocument };
