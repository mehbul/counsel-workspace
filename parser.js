const { fork, spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { ocrStatus } = require("./ocr");
let running = 0;
async function parseDocumentDetailed(buffer, ext) {
  if (running >= 2) throw Error("Document processing is busy. Retry shortly.");
  running++;
  let directory;
  try {
    const enabled = ext === ".pdf" && ocrStatus().enabled;
    if (enabled)
      directory = await fs.mkdtemp(path.join(os.tmpdir(), "counsel-ocr-"));
    return await new Promise((resolve, reject) => {
      let settled = false,
        result,
        terminating = false;
      const child = fork(path.join(__dirname, "parse-process.js"), [], {
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: ["--max-old-space-size=192"],
        detached: process.platform !== "win32",
        windowsHide: true,
        env: Object.fromEntries(
          [
            "PATH",
            "SystemRoot",
            "TEMP",
            "TMP",
            "HOME",
            "COUNSEL_OCR_ENABLED",
            "COUNSEL_OCR_TESSERACT",
            "COUNSEL_OCR_PDFTOPPM",
            "COUNSEL_OCR_LANGUAGE",
            "TESSDATA_PREFIX",
          ]
            .filter((key) => process.env[key])
            .map((key) => [key, process.env[key]]),
        ),
      });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.connected) child.disconnect();
        error ? reject(error) : resolve(value);
      };
      // Kill the entire process tree before removing its private temporary files.
      const terminate = (message) => {
        if (terminating || settled) return;
        terminating = true;
        if (process.platform === "win32" && child.pid) {
          const killer = spawn(
            path.join(
              process.env.SystemRoot || "C:\\Windows",
              "System32",
              "taskkill.exe",
            ),
            ["/pid", String(child.pid), "/T", "/F"],
            { shell: false, windowsHide: true, stdio: "ignore" },
          );
          killer.once("error", () => {
            if (child.connected) child.disconnect();
            child.kill();
          });
          killer.once("close", () => finish(Error(message)));
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
          child.once("close", () => finish(Error(message)));
        }
      };
      const timer = setTimeout(
        () => terminate("Document parsing exceeded its time limit."),
        enabled ? 150000 : 30000,
      );
      child.once("message", (message) => {
        result = message;
      });
      child.once("error", () =>
        finish(Error("Document parser could not start.")),
      );
      child.once("exit", (code) => {
        if (terminating) return;
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
      child.send({ data: buffer, ext, tempDirectory: directory }, (error) => {
        if (error) terminate("Unable to send document to parser.");
      });
    });
  } finally {
    try {
      if (directory)
        await fs.rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
    } finally {
      running--;
    }
  }
}
async function parseDocument(buffer, ext) {
  return (await parseDocumentDetailed(buffer, ext)).text;
}
module.exports = { parseDocument, parseDocumentDetailed, ocrStatus };
