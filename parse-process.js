process.once("message", async (input) => {
  try {
    const buffer = Buffer.from(input.data);
    let text;
    if (input.ext === ".pdf") {
      const { PDFParse } = require("pdf-parse");
      const parser = new PDFParse({ data: buffer });
      try {
        text = (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    } else if (input.ext === ".docx") {
      text = (await require("mammoth").extractRawText({ buffer })).value;
    } else {
      text = buffer.toString("utf8");
    }
    if (text.length > 2000000) throw Error("Document too large");
    process.send({ text }, () => process.disconnect());
  } catch {
    process.send(
      {
        error:
          "Document could not be parsed. Check that it is valid and contains readable text.",
      },
      () => process.disconnect(),
    );
  }
});
