const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const LIMITS = Object.freeze({
  pages: 20,
  totalMs: 120000,
  processMs: 20000,
  rasterBytes: 32 * 1024 * 1024,
  textBytes: 2 * 1024 * 1024,
  inputBytes: 50 * 1024 * 1024,
});
class OcrError extends Error {}
function ocrStatus(env = process.env) {
  const enabled = env.COUNSEL_OCR_ENABLED === "1";
  return {
    enabled,
    available: enabled ? null : false,
    reason: enabled
      ? "Local OCR is enabled; executable and language availability is checked when needed."
      : "Local OCR is disabled. Install Tesseract and Poppler, then set COUNSEL_OCR_ENABLED=1. See docs/OCR.md.",
  };
}
function run(
  command,
  args,
  { timeoutMs = LIMITS.processMs, maxBytes = LIMITS.textBytes, signal } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new OcrError("Local OCR was cancelled."));
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OMP_THREAD_LIMIT: "1" },
    });
    let chunks = [],
      size = 0,
      failure;
    const stop = (message) => {
      failure ||= new OcrError(message);
      child.kill("SIGKILL");
    };
    const abort = () => stop("Local OCR was cancelled.");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => stop("Local OCR exceeded its time limit."),
      timeoutMs,
    );
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes)
        stop("Local OCR output exceeds the supported limit.");
      else chunks.push(chunk);
    });
    // Drain diagnostics without retaining potentially sensitive or unbounded input.
    child.stderr.on("data", () => {});
    child.once("error", () => {
      failure = new OcrError(
        "Local OCR is unavailable. Install Tesseract and Poppler or check COUNSEL_OCR_TESSERACT and COUNSEL_OCR_PDFTOPPM. See docs/OCR.md.",
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new OcrError(
            "Local OCR failed. Check the PDF, installed Tesseract language data and local engine configuration. See docs/OCR.md.",
          ),
        );
      else resolve(Buffer.concat(chunks));
    });
  });
}
async function recognizePages(buffer, pageNumbers, options = {}) {
  if (!ocrStatus().enabled) throw new OcrError("Local OCR is disabled.");
  if (pageNumbers.length > LIMITS.pages)
    throw new OcrError(
      `Local OCR supports at most ${LIMITS.pages} image-only pages per document. Split this PDF and retry.`,
    );
  if (buffer.length > LIMITS.inputBytes)
    throw new OcrError("Local OCR input exceeds 50 MiB.");
  if (pageNumbers.some((page) => !Number.isSafeInteger(page) || page < 1))
    throw new OcrError("Invalid OCR page number.");
  const execute = options.run || run;
  const language = process.env.COUNSEL_OCR_LANGUAGE || "eng";
  if (!/^[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*$/.test(language))
    throw new OcrError("Invalid COUNSEL_OCR_LANGUAGE configuration.");
  const directory =
    options.tempDirectory ||
    (await fs.mkdtemp(path.join(os.tmpdir(), "counsel-ocr-")));
  const started = Date.now(),
    result = new Map();
  try {
    const input = path.join(directory, "input.pdf"),
      image = path.join(directory, "page.ppm");
    await fs.writeFile(input, buffer, { mode: 0o600 });
    for (const page of pageNumbers) {
      const runOptions = (maxBytes) => {
        const remaining = LIMITS.totalMs - (Date.now() - started);
        if (remaining <= 0)
          throw new OcrError("Local OCR exceeded its total time limit.");
        return {
          signal: options.signal,
          timeoutMs: Math.min(LIMITS.processMs, remaining),
          maxBytes,
        };
      };
      const raster = await execute(
        process.env.COUNSEL_OCR_PDFTOPPM || "pdftoppm",
        [
          "-f",
          String(page),
          "-l",
          String(page),
          "-singlefile",
          "-scale-to",
          "2400",
          input,
        ],
        runOptions(LIMITS.rasterBytes),
      );
      await fs.writeFile(image, raster, { mode: 0o600 });
      const output = await execute(
        process.env.COUNSEL_OCR_TESSERACT || "tesseract",
        [image, "stdout", "-l", language],
        runOptions(LIMITS.textBytes),
      );
      result.set(page, output.toString("utf8").replace(/\f/g, "").trim());
      await fs.unlink(image);
    }
    return result;
  } finally {
    if (!options.tempDirectory)
      await fs.rm(directory, { recursive: true, force: true });
  }
}
module.exports = { LIMITS, OcrError, ocrStatus, recognizePages, run };
