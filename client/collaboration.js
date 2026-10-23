import * as Y from "yjs";
let dispose;
window.CounselCollab = {
  detach() {
    dispose?.();
    dispose = null;
  },
  attach(draftId, textarea, status) {
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
    textarea.disabled = true;
    const label = (s) => {
      if (status) status.textContent = s;
    };
    function show() {
      const start = textarea.selectionStart,
        end = textarea.selectionEnd;
      textarea.value = text.toString();
      textarea.setSelectionRange(
        Math.min(start, textarea.value.length),
        Math.min(end, textarea.value.length),
      );
    }
    text.observe(show);
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
      if (origin === "local") {
        hasLocal = true;
        label("Saving changes…");
        send(update);
      }
    });
    textarea.oninput = () => {
      if (!ready) return;
      const before = text.toString(),
        after = textarea.value;
      let start = 0;
      while (
        start < before.length &&
        start < after.length &&
        before[start] === after[start]
      )
        start++;
      let end = 0;
      while (
        end < before.length - start &&
        end < after.length - start &&
        before[before.length - 1 - end] === after[after.length - 1 - end]
      )
        end++;
      doc.transact(() => {
        text.delete(start, before.length - start - end);
        text.insert(start, after.slice(start, after.length - end));
      }, "local");
    };
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
            textarea.disabled = m.readOnly;
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
        textarea.disabled = true;
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
      textarea.oninput = null;
      ws?.close();
      doc.destroy();
    };
  },
};
