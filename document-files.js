const { createHash } = require("node:crypto");
const { context } = require("./security");

function createDocumentFiles(db, getContext = () => context.getStore()) {
  db.exec(`CREATE TABLE IF NOT EXISTS document_originals (
    workspace_id TEXT NOT NULL, document_id TEXT NOT NULL, matter_id TEXT NOT NULL,
    name TEXT NOT NULL, mime TEXT NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL,
    PRIMARY KEY(workspace_id, document_id))`);
  function authorized(id) {
    const c = getContext();
    const d = c?.state?.documents?.find((item) => item.id === id);
    if (!d || !c.state.matters.some((m) => m.id === d.matterId)) {
      const error = Error("Document not found.");
      error.status = 404;
      throw error;
    }
    return { c, d };
  }
  return {
    retain(id, bytes, mime = "application/octet-stream") {
      const { c, d } = authorized(id);
      if (!Buffer.isBuffer(bytes) || bytes.length > 25 * 1024 * 1024)
        throw Error("Original file exceeds the supported limit.");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      db.prepare("INSERT INTO document_originals VALUES(?,?,?,?,?,?,?)").run(
        c.workspaceId,
        id,
        d.matterId,
        d.name,
        mime,
        sha256,
        bytes,
      );
      return { sha256, size: bytes.length };
    },
    read(id) {
      const { c, d } = authorized(id);
      const row = db
        .prepare(
          "SELECT * FROM document_originals WHERE workspace_id=? AND document_id=? AND matter_id=?",
        )
        .get(c.workspaceId, id, d.matterId);
      if (!row) {
        const error = Error("Original file is unavailable for this document.");
        error.status = 404;
        throw error;
      }
      return {
        name: row.name,
        mime: row.mime,
        sha256: row.sha256,
        bytes: Buffer.from(row.bytes),
      };
    },
    install(app) {
      app.get("/api/documents/:id/original", (req, res, next) => {
        try {
          const file = this.read(req.params.id);
          res.set("Cache-Control", "no-store");
          res.set("X-Content-Type-Options", "nosniff");
          res
            .attachment(file.name)
            .type("application/octet-stream")
            .send(file.bytes);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
module.exports = { createDocumentFiles };
