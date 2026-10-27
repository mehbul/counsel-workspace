const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { extractDocument } = require("../parse-content");
const { parseDocumentDetailed } = require("../parser");
const { recognizePages, run, LIMITS } = require("../ocr");

async function scannedPdf(mixed = false) {
  const jpeg = await fs.readFile(path.join(__dirname, "fixtures/ocr-scan.jpg"));
  const stream = (data, extra = "") =>
    Buffer.concat([
      Buffer.from(`<< /Length ${data.length} ${extra} >>\nstream\n`),
      data,
      Buffer.from("\nendstream"),
    ]);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [3 0 R${mixed ? " 7 0 R" : ""}] /Count ${mixed ? 2 : 1} >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 300] /Resources << /XObject << /Scan 5 0 R >> >> /Contents 4 0 R >>",
    stream(Buffer.from("q 800 0 0 300 0 0 cm /Scan Do Q")),
    stream(
      jpeg,
      "/Type /XObject /Subtype /Image /Width 1600 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
    ),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 300] /Resources << /Font << /F1 6 0 R >> >> /Contents 8 0 R >>",
    stream(
      Buffer.from("BT /F1 18 Tf 30 200 Td (Native indemnity clause) Tj ET"),
    ),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")],
    offsets = [0];
  let length = chunks[0].length;
  objects.forEach((obj, i) => {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      Buffer.isBuffer(obj) ? obj : Buffer.from(obj),
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(part);
    length += part.length;
  });
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`,
    ),
  );
  return Buffer.concat(chunks);
}
function enabled(t) {
  const old = process.env.COUNSEL_OCR_ENABLED;
  process.env.COUNSEL_OCR_ENABLED = "1";
  t.after(() =>
    old === undefined
      ? delete process.env.COUNSEL_OCR_ENABLED
      : (process.env.COUNSEL_OCR_ENABLED = old),
  );
}
test("disabled scanned PDF retains exact native anchors and reports need", async (t) => {
  const old = process.env.COUNSEL_OCR_ENABLED;
  delete process.env.COUNSEL_OCR_ENABLED;
  t.after(() => {
    if (old !== undefined) process.env.COUNSEL_OCR_ENABLED = old;
  });
  const result = await extractDocument(await scannedPdf(true), ".pdf");
  assert.equal(result.ocr.needed, true);
  assert.equal(result.ocr.enabled, false);
  assert.equal(result.ocr.available, false);
  assert.equal(
    result.text.slice(result.pages[0].start, result.pages[0].end),
    "",
  );
  assert.match(
    result.text.slice(result.pages[1].start, result.pages[1].end),
    /Native indemnity clause/,
  );
});
test("enabled mixed PDF OCRs only missing pages and cleans private files", async (t) => {
  enabled(t);
  let directory;
  const calls = [];
  const result = await extractDocument(await scannedPdf(true), ".pdf", {
    run: async (command, args, options) => {
      calls.push(args);
      assert.ok(options.timeoutMs <= LIMITS.processMs);
      if (args.includes("-singlefile")) {
        directory = path.dirname(args.at(-1));
        assert.ok((await fs.readFile(args.at(-1))).length);
        return Buffer.from("fake raster");
      }
      return Buffer.from("Supplier must deliver cobalt turbines.\f");
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], "1");
  assert.deepEqual(result.ocr.processedPages, [1]);
  assert.equal(result.ocr.available, true);
  assert.equal(
    result.text.slice(result.pages[0].start, result.pages[0].end),
    "Supplier must deliver cobalt turbines.",
  );
  assert.match(
    result.text.slice(result.pages[1].start, result.pages[1].end),
    /Native indemnity clause/,
  );
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});
test("missing engines produce actionable error through isolated parser", async (t) => {
  enabled(t);
  const old = process.env.COUNSEL_OCR_PDFTOPPM;
  process.env.COUNSEL_OCR_PDFTOPPM = path.join(
    __dirname,
    "nonexistent-ocr-engine",
  );
  t.after(() =>
    old === undefined
      ? delete process.env.COUNSEL_OCR_PDFTOPPM
      : (process.env.COUNSEL_OCR_PDFTOPPM = old),
  );
  await assert.rejects(
    parseDocumentDetailed(await scannedPdf(), ".pdf"),
    /Local OCR is unavailable.*Tesseract and Poppler/,
  );
});
test("OCR failure cleans its private directory and page limits reject early", async (t) => {
  enabled(t);
  let directory;
  await assert.rejects(
    recognizePages(Buffer.from("pdf"), [1], {
      run: async (_, args) => {
        directory = path.dirname(args.at(-1));
        throw Error("engine failure");
      },
    }),
    /engine failure/,
  );
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
  await assert.rejects(
    recognizePages(Buffer.from("pdf"), Array(21).fill(1)),
    /at most 20/,
  );
});
test("subprocess output, deadline, cancellation and unavailable limits", async () => {
  await assert.rejects(
    run(process.execPath, ["-e", 'process.stdout.write("x".repeat(10000))'], {
      maxBytes: 100,
    }),
    /output exceeds/,
  );
  await assert.rejects(
    run(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], {
      timeoutMs: 100,
    }),
    /time limit/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    run(process.execPath, [], { signal: controller.signal }),
    /cancelled/,
  );
  await assert.rejects(
    run("nonexistent-counsel-ocr-engine", []),
    /unavailable/,
  );
});
test(
  "real Tesseract + Poppler extract scanned and mixed PDFs with page anchors",
  { skip: process.env.COUNSEL_TEST_REAL_OCR !== "1", timeout: 150000 },
  async (t) => {
    enabled(t);
    for (const mixed of [false, true]) {
      const result = await parseDocumentDetailed(
        await scannedPdf(mixed),
        ".pdf",
      );
      assert.equal(result.ocr.available, true);
      assert.deepEqual(result.ocr.processedPages, [1]);
      assert.match(
        result.text.slice(result.pages[0].start, result.pages[0].end),
        /cobalt turbines/i,
      );
      if (mixed)
        assert.match(
          result.text.slice(result.pages[1].start, result.pages[1].end),
          /Native indemnity clause/,
        );
    }
  },
);

test(
  "real scanned upload is searchable in its matter",
  { skip: process.env.COUNSEL_TEST_REAL_OCR !== "1", timeout: 150000 },
  async (t) => {
    enabled(t);
    const directory = await fs.mkdtemp(
      path.join(require("node:os").tmpdir(), "counsel-ocr-app-"),
    );
    process.env.DATA_DIR = directory;
    process.env.COUNSEL_DB = ":memory:";
    const { app, db, jobs, workflows, collaboration } = require("../server");
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    let cookie = "",
      csrf = "";
    const request = async (route, body) => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/${route}`,
        {
          method: "POST",
          headers: {
            ...(body instanceof FormData
              ? {}
              : { "Content-Type": "application/json" }),
            Cookie: cookie,
            "X-CSRF-Token": csrf,
          },
          body: body instanceof FormData ? body : JSON.stringify(body),
        },
      );
      if (response.headers.get("set-cookie"))
        cookie = response.headers.get("set-cookie").split(";")[0];
      const data = await response.json();
      if (data.csrf) csrf = data.csrf;
      assert.ok(response.ok, JSON.stringify(data));
      return data;
    };
    try {
      await request("auth/setup", {
        token: await fs.readFile(
          path.join(directory, "bootstrap-token"),
          "utf8",
        ),
        email: "ocr@example.test",
        password: "secure OCR test passphrase 123",
        workspace: "OCR test",
      });
      const matter = await request("matters", {
        name: "Scanned supply agreement",
        client: "Synthetic",
      });
      const form = new FormData();
      form.append("matterId", matter.id);
      form.append(
        "files",
        new Blob([await scannedPdf(true)], { type: "application/pdf" }),
        "scanned.pdf",
      );
      const imported = await request("documents", form);
      assert.equal(imported.length, 1);
      const result = await request("chat", {
        matterId: matter.id,
        query: "cobalt turbines",
      });
      assert.ok(result.citations.length > 0);
      assert.ok(
        result.citations.every(
          (citation) => citation.documentId === imported[0].id,
        ),
      );
      assert.match(JSON.stringify(result.citations), /cobalt turbines/i);
    } finally {
      collaboration.close();
      await workflows.close();
      await jobs.close();
      await new Promise((resolve) => server.close(resolve));
      db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
