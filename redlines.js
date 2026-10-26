const {
  Document,
  Paragraph,
  TextRun,
  InsertedTextRun,
  DeletedTextRun,
  Packer,
} = require("docx");
const { context } = require("./security");

// Every character participates. Very large changed regions use a coarse replacement
// rather than quadratic memory or a silently truncated comparison.
function completeDiff(before, after) {
  if (
    typeof before !== "string" ||
    typeof after !== "string" ||
    before.length > 2000000 ||
    after.length > 2000000
  )
    throw Error("Unsupported document text.");
  const a = before.match(/\s+|[^\s]+/gu) || [],
    b = after.match(/\s+|[^\s]+/gu) || [];
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const x = a.slice(start, a.length - end),
    y = b.slice(start, b.length - end),
    parts = [];
  const push = (kind, text) => {
    if (!text) return;
    if (parts.at(-1)?.kind === kind) parts.at(-1).text += text;
    else parts.push({ kind, text });
  };
  push("equal", a.slice(0, start).join(""));
  const coarse = (x.length + 1) * (y.length + 1) > 2000000;
  if (coarse) {
    push("removed", x.join(""));
    push("added", y.join(""));
  } else {
    const width = y.length + 1,
      matrix = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        matrix[i * width + j] =
          x[i] === y[j]
            ? matrix[(i + 1) * width + j + 1] + 1
            : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
    let i = 0,
      j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        push("equal", x[i++]);
        j++;
      } else if (
        j < y.length &&
        (i === x.length ||
          matrix[i * width + j + 1] > matrix[(i + 1) * width + j])
      )
        push("added", y[j++]);
      else push("removed", x[i++]);
    }
  }
  push("equal", a.slice(a.length - end).join(""));
  return {
    equal: before === after,
    truncated: false,
    coarse,
    parts,
    beforeCharacters: before.length,
    afterCharacters: after.length,
    notice:
      "Complete extracted-text comparison. Word export reconstructs text with tracked changes; original formatting, tables, images and existing revisions are not preserved. Inspect original files before relying on this result.",
  };
}
async function trackedChangeDocx(diff, author = "Counsel Workspace") {
  let id = 0;
  const date = new Date().toISOString();
  const children = [];
  for (const part of diff.parts) {
    const lines = part.text.split("\n");
    lines.forEach((text, index) => {
      const options = { text, ...(index ? { break: 1 } : {}) };
      children.push(
        part.kind === "equal"
          ? new TextRun(options)
          : new (part.kind === "added" ? InsertedTextRun : DeletedTextRun)({
              ...options,
              id: ++id,
              author,
              date,
            }),
      );
    });
  }
  return Packer.toBuffer(
    new Document({
      features: { trackRevisions: true },
      sections: [{ children: [new Paragraph({ children })] }],
    }),
  );
}
function installRedlines(app, getContext = () => context.getStore()) {
  const compare = (req) => {
    const c = getContext(),
      ids = req.body?.documentIds;
    if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1]) {
      const e = Error("Select two different documents.");
      e.status = 400;
      throw e;
    }
    const docs = ids.map((id) =>
      c.state.documents.find(
        (d) => d.id === id && c.state.matters.some((m) => m.id === d.matterId),
      ),
    );
    if (docs.some((d) => !d) || docs[0].matterId !== docs[1].matterId) {
      const e = Error("Documents not found in the same accessible matter.");
      e.status = 404;
      throw e;
    }
    return completeDiff(docs[0].text, docs[1].text);
  };
  app.post("/api/documents/compare-full", (req, res, next) => {
    try {
      res.json(compare(req));
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/documents/redline.docx", async (req, res, next) => {
    try {
      const bytes = await trackedChangeDocx(compare(req));
      res
        .set("Cache-Control", "no-store")
        .attachment("tracked-changes.docx")
        .send(bytes);
    } catch (e) {
      next(e);
    }
  });
}
module.exports = { completeDiff, trackedChangeDocx, installRedlines };
