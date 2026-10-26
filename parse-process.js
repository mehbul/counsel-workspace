const { extractDocument } = require("./parse-content");
process.once("message", async (input) => {
  try {
    const result = await extractDocument(Buffer.from(input.data), input.ext);
    process.send(result, () => process.disconnect());
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
