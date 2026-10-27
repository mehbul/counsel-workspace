const { ocrStatus, recognizePages } = require("./ocr");
async function extractDocument(buffer, ext, options = {}) {
  const ocr = { ...ocrStatus(), needed: false, processedPages: [] };
  let text,
    pages = [];
  if (ext === ".pdf") {
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const missing = result.pages
        .filter((page) => !page.text.trim())
        .map((page) => page.num);
      ocr.needed = missing.length > 0;
      const recognized =
        ocr.enabled && missing.length
          ? await recognizePages(buffer, missing, options)
          : new Map();
      if (recognized.size) {
        ocr.available = true;
        ocr.processedPages = [...recognized.keys()];
        ocr.reason = "Text extracted using local Tesseract OCR.";
      }
      text = "";
      for (const page of result.pages) {
        if (text) text += "\n\n";
        const start = text.length;
        text += recognized.has(page.num) ? recognized.get(page.num) : page.text;
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
    ocr,
  };
}
module.exports = { extractDocument };
