const { paragraphRanges } = require("./suite");

// This runner sees public prompts and documents only. Labels are not passed to the retrieval function.
function retrievalPredictions(suite, options = {}) {
  const documents = new Map(suite.documents.map((d) => [d.id, d]));
  const split = options.split || "test",
    retrieve = options.retrieve || require("../retrieval").retrieve;
  const queryMode = options.queryMode || "full";
  if (!["full", "category"].includes(queryMode))
    throw Error("Choose full or category question mode.");
  return suite.prompts
    .filter((p) => p.split === split)
    .map((p) => {
      const d = documents.get(p.documentId);
      if (!d || d.sha256 !== p.documentSha256)
        throw Error("Retrieval source mismatch.");
      const query = queryMode === "category" ? p.category : p.question;
      const results = retrieve(
        query,
        [{ id: d.id, name: d.title, text: d.text }],
        { limit: 3, maxPerDocument: 3, maxChars: 3000 },
      );
      const paragraphs = paragraphRanges(d.text);
      const answers = results.map((c) => {
        const paragraph = paragraphs[c.paragraph - 1];
        const offset = Number.isInteger(c.startOffset)
          ? c.startOffset
          : paragraph?.text.indexOf(c.text);
        const start = paragraph ? paragraph.start + offset : -1;
        return { start, end: start + c.text.length, text: c.text };
      });
      return {
        id: p.id,
        documentId: d.id,
        documentSha256: d.sha256,
        abstained: answers.length === 0,
        answers,
        citations: results.map((c) => ({
          documentId: c.documentId,
          paragraph: c.paragraph,
          quote: c.text,
        })),
      };
    });
}
module.exports = { retrievalPredictions };
