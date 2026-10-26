const { parentPort, workerData } = require("node:worker_threads");
const { extractDocument } = require("./parse-content");
extractDocument(Buffer.from(workerData.data), workerData.ext)
  .then((result) => parentPort.postMessage(result))
  .catch(() =>
    parentPort.postMessage({
      error:
        "Document could not be parsed. Check that it is valid and contains readable text.",
    }),
  );
