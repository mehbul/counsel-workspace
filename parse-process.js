const { extractDocument } = require("./parse-content");
const { OcrError } = require("./ocr");
const controller = new AbortController();
process.once("disconnect", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
process.once("message", async (input) => {
  try {
    const result = await extractDocument(Buffer.from(input.data), input.ext, {
      signal: controller.signal,
      tempDirectory: input.tempDirectory,
    });
    process.send(result, () => process.disconnect());
  } catch (error) {
    process.send(
      {
        error:
          error instanceof OcrError
            ? error.message
            : "Document could not be parsed. Check that it is valid and contains readable text.",
      },
      () => process.disconnect(),
    );
  }
});
