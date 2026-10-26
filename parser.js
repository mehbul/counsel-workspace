const { fork } = require("node:child_process");
const path = require("node:path");
let running = 0;
function parseDocumentDetailed(buffer, ext) {
  if (running >= 2)
    return Promise.reject(Error("Document processing is busy. Retry shortly."));
  running++;
  return new Promise((resolve, reject) => {
    let settled = false,
      result;
    const child = fork(path.join(__dirname, "parse-process.js"), [], {
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: ["--max-old-space-size=192"],
      env: Object.fromEntries(
        ["PATH", "SystemRoot", "TEMP", "TMP", "HOME"]
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]]),
      ),
    });
    const finish = (err, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running--;
      if (child.connected) child.disconnect();
      err ? reject(err) : resolve(text);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(Error("Document parsing exceeded its time limit."));
    }, 30000);
    child.once("message", (message) => {
      result = message;
    });
    child.once("error", () =>
      finish(Error("Document parser could not start.")),
    );
    child.once("exit", (code) => {
      if (code !== 0 || !result)
        return finish(
          Error(
            "Document parser exited unexpectedly. The application is still available.",
          ),
        );
      finish(result.error ? Error(result.error) : null, {
        text: result.text,
        pages: result.pages || [],
        ocr: result.ocr,
      });
    });
    child.send({ data: buffer, ext }, (err) => {
      if (err) {
        child.kill();
        finish(Error("Unable to send document to parser."));
      }
    });
  });
}
async function parseDocument(buffer, ext) {
  return (await parseDocumentDetailed(buffer, ext)).text;
}
function ocrStatus() {
  return {
    available: false,
    enabled: false,
    reason:
      "No OCR engine is configured. Image-only PDFs require a separate, explicitly enabled OCR integration.",
  };
}
module.exports = { parseDocument, parseDocumentDetailed, ocrStatus };
