# Local scanned-PDF OCR

OCR is disabled by default. It runs locally with operator-installed Tesseract and Poppler; documents are not sent to an OCR service and the application does not download engines or models.

On Debian/Ubuntu, install `tesseract-ocr`, `tesseract-ocr-eng`, and `poppler-utils`. On other systems install Tesseract and Poppler from a trusted distribution. Confirm `tesseract --version` and `pdftoppm -v` work under the application's account. Set `COUNSEL_OCR_ENABLED=1` and restart the app.

Configuration:

- `COUNSEL_OCR_TESSERACT`: optional absolute path to the Tesseract executable; defaults to `tesseract` on PATH.
- `COUNSEL_OCR_PDFTOPPM`: optional absolute path to the Poppler executable; defaults to `pdftoppm` on PATH.
- `COUNSEL_OCR_LANGUAGE`: installed Tesseract language codes, default `eng`; for example `eng+fra`. Install the corresponding language data yourself.
- `TESSDATA_PREFIX`: optional Tesseract data directory.

Only PDF pages with no extracted text are OCRed. Native-text pages retain their extracted text. Mixed documents keep page order and exact character offsets into the combined text, so citations can identify each page. Pages with an existing incomplete or incorrect text layer are not automatically OCRed. OCR can make recognition mistakes; verify important clauses against the original PDF.

Enabled status does not prove that engines or language data are installed. Availability is confirmed when OCR succeeds. Missing engines, language failures, and processing limits return actionable import errors; they do not silently import a partial mixed document. Disabled OCR reports that unreadable pages need OCR.

Processing is limited to 20 missing-text pages, 50 MiB input, 20 seconds per external process, 120 seconds total OCR time, 32 MiB raster output per page, and 2 MiB OCR text output per page. Final document text is limited to two million characters. At most two document parser processes run concurrently. The parser has a 150-second outer deadline when OCR is enabled, with process-tree termination. Each import uses a private temporary directory removed after success or failure. Allow the service account access to its temporary directory and sufficient temporary disk space.

## Verification

Run `node --test test/ocr.test.js test/parser-fidelity.test.js` for disabled/enabled behavior, mixed-page anchors, unavailable engines, subprocess bounds, and cleanup checks. Engine-independent tests use a fake subprocess boundary.

After installing both engines, run `COUNSEL_TEST_REAL_OCR=1 node --test test/ocr.test.js` on Linux/macOS, or `$env:COUNSEL_TEST_REAL_OCR='1'; node --test test/ocr.test.js` in PowerShell. This opt-in test must fail if the engines are unavailable. It recognizes the checked-in synthetic scan, checks scanned and mixed PDF page anchors, uploads a scanned PDF to a temporary application workspace, and searches its matter for the recognized words. No external model is needed.
