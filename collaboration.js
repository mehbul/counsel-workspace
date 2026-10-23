const { WebSocketServer, WebSocket } = require("ws");
const Y = require("yjs");
const { randomUUID } = require("node:crypto");
const { context } = require("./security");
function createCollaboration(db, security, save) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS collaborative_drafts(workspace_id TEXT NOT NULL,draft_id TEXT NOT NULL,content BLOB NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(workspace_id,draft_id))",
  );
  const rooms = new Map();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
  });
  function authorized(req, draftId) {
    const user = security.session(req);
    if (!user) return null;
    const row = db
      .prepare("SELECT value FROM workspaces WHERE id=?")
      .get(user.workspace_id);
    if (!row) return null;
    const draft = JSON.parse(row.value).drafts.find((d) => d.id === draftId);
    if (!draft) return null;
    if (
      user.role !== "owner" &&
      !db
        .prepare(
          "SELECT 1 FROM matter_access WHERE user_id=? AND matter_id=? AND workspace_id=?",
        )
        .get(user.id, draft.matterId, user.workspace_id)
    )
      return null;
    return { user, draft };
  }
  function send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 2 * 1024 * 1024)
        return ws.close(1013, "Client is too slow");
      ws.send(JSON.stringify(message));
    }
  }
  function presence(room) {
    const count = room.clients.size;
    for (const ws of room.clients) send(ws, { type: "presence", count });
  }
  function roomFor(user, draft) {
    const key = user.workspace_id + ":" + draft.id;
    let room = rooms.get(key);
    if (room) return room;
    const doc = new Y.Doc();
    const saved = db
      .prepare(
        "SELECT content FROM collaborative_drafts WHERE workspace_id=? AND draft_id=?",
      )
      .get(user.workspace_id, draft.id);
    if (saved) Y.applyUpdate(doc, new Uint8Array(saved.content));
    else doc.getText("content").insert(0, draft.content);
    if (!saved)
      db.prepare("INSERT INTO collaborative_drafts VALUES(?,?,?,?)").run(
        user.workspace_id,
        draft.id,
        Y.encodeStateAsUpdate(doc),
        new Date().toISOString(),
      );
    room = { key, doc, clients: new Set(), tail: Promise.resolve() };
    rooms.set(key, room);
    return room;
  }
  wss.on("connection", (ws, req, identity) => {
    const { user, draft } = identity,
      room = roomFor(user, draft);
    ws.identity = { req, draftId: draft.id };
    ws.peerId = randomUUID();
    room.clients.add(ws);
    send(ws, {
      type: "sync",
      update: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString("base64"),
      readOnly: user.role === "viewer",
    });
    presence(room);
    let count = 0;
    const rate = setInterval(() => (count = 0), 1000);
    rate.unref();
    ws.on("message", (raw) => {
      if (!authorized(req, draft.id)) return ws.close(1008, "Access revoked");
      if (++count > 30) return ws.close(1008, "Update rate exceeded");
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return ws.close(1008, "Invalid message");
      }
      if (message.type === "sync") {
        send(ws, {
          type: "sync",
          update: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString(
            "base64",
          ),
          readOnly: user.role === "viewer",
        });
        return;
      }
      if (
        message.type !== "update" ||
        typeof message.update !== "string" ||
        message.update.length > 350000
      )
        return ws.close(1008, "Invalid update");
      room.tail = room.tail
        .then(async () => {
          const current = authorized(req, draft.id);
          if (!current || current.user.role === "viewer")
            return ws.close(1008, "Edit access denied");
          await security.runWorkspace(
            current.user.id,
            current.user.workspace_id,
            async () => {
              const c = context.getStore();
              const target = c.state.drafts.find((d) => d.id === draft.id);
              if (!target) throw Error("Matter access revoked");
              const update = Buffer.from(message.update, "base64");
              // Validate on an isolated clone so a rejected update cannot poison the live room.
              const candidate = new Y.Doc();
              Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.doc));
              Y.applyUpdate(candidate, update);
              const content = candidate.getText("content").toString();
              if (content.length > 1000000) throw Error("Draft is too large");
              const encoded = Y.encodeStateAsUpdate(candidate);
              if (encoded.length > 4 * 1024 * 1024)
                throw Error("Draft history limit reached");
              db.exec("BEGIN IMMEDIATE");
              try {
                db.prepare(
                  "INSERT OR REPLACE INTO collaborative_drafts VALUES(?,?,?,?)",
                ).run(
                  c.workspaceId,
                  draft.id,
                  encoded,
                  new Date().toISOString(),
                );
                target.content = content;
                save();
                db.exec("COMMIT");
              } catch (e) {
                db.exec("ROLLBACK");
                throw e;
              }
              Y.applyUpdate(room.doc, update);
              candidate.destroy();
              for (const peer of room.clients) {
                if (!authorized(peer.identity.req, draft.id)) {
                  peer.close(1008, "Access revoked");
                  continue;
                }
                send(peer, { type: "update", update: message.update });
              }
              send(ws, {
                type: "saved",
                sequence: Number.isSafeInteger(message.sequence)
                  ? message.sequence
                  : 0,
              });
            },
          );
        })
        .catch(() => ws.close(1008, "Update rejected"));
    });
    ws.on("close", () => {
      clearInterval(rate);
      room.clients.delete(ws);
      presence(room);
      if (!room.clients.size)
        room.tail.finally(() => {
          if (!room.clients.size) {
            room.doc.destroy();
            rooms.delete(room.key);
          }
        });
    });
  });
  const guard = setInterval(() => {
    for (const ws of wss.clients) {
      if (!authorized(ws.identity.req, ws.identity.draftId))
        ws.close(1008, "Access revoked");
      else {
        if (ws.alive === false) {
          ws.terminate();
          continue;
        }
        ws.alive = false;
        ws.ping();
      }
    }
  }, 5000);
  guard.unref();
  wss.on("connection", (ws) => {
    ws.alive = true;
    ws.on("pong", () => (ws.alive = true));
  });
  function attach(server) {
    server.on("upgrade", (req, socket, head) => {
      let url;
      try {
        url = new URL(req.url, "http://localhost");
      } catch {
        return socket.destroy();
      }
      if (url.pathname !== "/collaboration") return socket.destroy();
      const expected = process.env.APP_ORIGIN || `http://${req.headers.host}`;
      if (req.headers.origin !== expected) return socket.destroy();
      const draftId = url.searchParams.get("draft");
      if (!/^[0-9a-f-]{36}$/i.test(draftId || "")) return socket.destroy();
      if (wss.clients.size >= 500) return socket.destroy();
      const identity = authorized(req, draftId);
      if (!identity) return socket.destroy();
      const same = [...wss.clients].filter(
        (ws) => ws.identity?.req.headers.cookie === req.headers.cookie,
      ).length;
      if (same >= 10) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req, identity),
      );
    });
  }
  return {
    attach,
    close() {
      clearInterval(guard);
      for (const ws of wss.clients) ws.close(1001, "Server shutting down");
      wss.close();
    },
  };
}
module.exports = { createCollaboration };
