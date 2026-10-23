const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const buffer = Buffer.from(workerData.data);
  let text;
  if (workerData.ext === ".pdf") {
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      text = (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  } else if (workerData.ext === ".docx")
    text = (await require("mammoth").extractRawText({ buffer })).value;
  else text = buffer.toString("utf8");
  if (text.length > 2000000)
    throw Error("Document text exceeds the supported limit.");
  parentPort.postMessage({ text });
})().catch(() =>
  parentPort.postMessage({
    error:
      "Document could not be parsed. Check that it is valid and contains readable text.",
  }),
);
