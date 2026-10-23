import * as Y from "yjs";
import Quill from "quill";
import { QuillBinding } from "y-quill";
import "quill/dist/quill.snow.css";
let dispose;
window.CounselCollab = {
  detach() {
    dispose?.();
    dispose = null;
  },
  attach(draftId, element, status) {
    this.detach();
    const doc = new Y.Doc(),
      text = doc.getText("content");
    let ws,
      ready = false,
      closed = false,
      timer,
      hasLocal = false,
      sequence = 0,
      acked = 0;
    let binding, undo;
    const quill = new Quill(element, {
      theme: "snow",
      readOnly: true,
      formats: [
        "bold",
        "italic",
        "underline",
        "strike",
        "header",
        "list",
        "blockquote",
        "align",
        "indent",
      ],
      modules: {
        history: false,
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ["bold", "italic", "underline", "strike"],
          [{ list: "ordered" }, { list: "bullet" }],
          ["blockquote"],
          [{ align: [] }],
          ["clean"],
        ],
        keyboard: {
          bindings: {
            undo: {
              key: "z",
              shortKey: true,
              handler: () => {
                undo?.undo();
                return false;
              },
            },
            redo: {
              key: "z",
              shortKey: true,
              shiftKey: true,
              handler: () => {
                undo?.redo();
                return false;
              },
            },
          },
        },
      },
    });
    quill.root.setAttribute("aria-label", "Draft content");
    const label = (s) => {
      if (status) status.textContent = s;
    };
    this.undo = () => undo?.undo();
    this.redo = () => undo?.redo();
    const send = (update) => {
      if (ws?.readyState === WebSocket.OPEN) {
        let binary = "";
        for (const b of update) binary += String.fromCharCode(b);
        ws.send(
          JSON.stringify({
            type: "update",
            update: btoa(binary),
            sequence: ++sequence,
          }),
        );
      }
    };
    doc.on("update", (update, origin) => {
      if (origin === binding || origin === undo) {
        hasLocal = true;
        label("Saving changes…");
        send(update);
      }
    });
    function connect() {
      if (closed) return;
      label("Connecting to shared draft…");
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/collaboration?draft=${encodeURIComponent(draftId)}`,
      );
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.update) {
          const update = Uint8Array.from(atob(m.update), (c) =>
            c.charCodeAt(0),
          );
          Y.applyUpdate(doc, update, "remote");
          if (m.type === "sync") {
            ready = true;
            if (!binding) {
              binding = new QuillBinding(text, quill);
              undo = new Y.UndoManager(text, {
                trackedOrigins: new Set([binding]),
              });
            }
            quill.enable(!m.readOnly);
            label(
              m.readOnly
                ? "Read-only shared draft"
                : "Connected · changes save automatically",
            );
            if (hasLocal) {
              send(Y.encodeStateAsUpdate(doc));
            }
          }
        }
        if (m.type === "saved") {
          acked = Math.max(acked, m.sequence || 0);
          hasLocal = acked < sequence;
          if (!hasLocal) label("All changes saved");
        }
        if (m.type === "presence")
          label(
            `${m.count} ${m.count === 1 ? "person" : "people"} in this draft`,
          );
      };
      ws.onclose = (e) => {
        quill.enable(false);
        ready = false;
        if (closed) return;
        if (e.code === 1008) {
          label("Access changed or update rejected. Reload to continue.");
          return;
        }
        label("Connection lost. Reconnecting…");
        timer = setTimeout(connect, 2000);
      };
    }
    connect();
    dispose = () => {
      closed = true;
      clearTimeout(timer);
      binding?.destroy();
      undo?.destroy();
      quill.enable(false);
      ws?.close();
      doc.destroy();
    };
  },
};
