(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CounselOffice = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function createClient(fetcher, token) {
    if (!/^counsel_[a-f0-9]{64}$/.test(token))
      throw Error("Paste a valid scoped Counsel assistant key.");
    let secret = token;
    async function invoke(operation, body = {}) {
      if (!secret) throw Error("Connect to Counsel first.");
      const response = await fetcher(`/agent/v1/${operation}`, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "Counsel request failed.");
      return result;
    }
    async function list(operation, matterId) {
      const items = [];
      let offset = 0;
      for (let page = 0; page < 100; page++) {
        const result = await invoke(operation, {
          ...(matterId ? { matterId } : {}),
          offset,
          limit: 50,
        });
        items.push(...result.items);
        if (result.nextOffset === null) return items;
        if (!(result.nextOffset > offset))
          throw Error("Invalid result pagination.");
        offset = result.nextOffset;
      }
      throw Error("Too many results. Narrow the scope of this connection key.");
    }
    return {
      session: () => invoke("session"),
      matters: () => list("list_matters"),
      drafts: (matterId) => list("list_drafts", matterId),
      async readDraft(matterId, draftId) {
        let content = "",
          offset = 0,
          total;
        for (let page = 0; page < 10; page++) {
          const result = await invoke("read_draft", {
            matterId,
            draftId,
            offset,
            limit: 24000,
          });
          if (result.characters > 200000)
            throw Error(
              "Draft is too large for this text bridge (200,000 characters).",
            );
          if (total !== undefined && total !== result.characters)
            throw Error("Draft changed while loading. Reload the preview.");
          total = result.characters;
          content += result.content;
          if (result.nextOffset === null) {
            if (content.length !== total)
              throw Error("Incomplete draft response. Reload the preview.");
            return { ...result, content };
          }
          if (!(result.nextOffset > offset))
            throw Error("Invalid draft pagination.");
          offset = result.nextOffset;
        }
        throw Error("Draft could not be loaded completely.");
      },
      importText: (matterId, name, text, requestId) =>
        invoke("import_text", { matterId, name, text, requestId }),
      saveDraft: (matterId, title, content, requestId) =>
        invoke("create_draft", {
          matterId,
          title,
          content,
          citations: [],
          requestId,
        }),
      disconnect() {
        secret = "";
      },
    };
  }
  async function readWordText(word, scope = "selection") {
    return word.run(async (context) => {
      const range =
        scope === "document"
          ? context.document.body
          : context.document.getSelection();
      range.load("text");
      await context.sync();
      if (!range.text?.trim())
        throw Error("The chosen Word scope has no readable text.");
      if (range.text.length > 200000)
        throw Error(
          "Selected text exceeds the 200,000 character bridge limit.",
        );
      return range.text;
    });
  }
  async function insertTrackedText(word, requirements, text) {
    if (!requirements.isSetSupported("WordApi", "1.4"))
      throw Error(
        "Tracked insertion requires WordApi 1.4. Update Word or use the tracked DOCX export.",
      );
    if (!text?.trim() || text.length > 200000)
      throw Error("Preview must contain between 1 and 200,000 characters.");
    return word.run(async (context) => {
      const document = context.document;
      document.load("changeTrackingMode");
      await context.sync();
      const originalMode = document.changeTrackingMode;
      try {
        document.changeTrackingMode = word.ChangeTrackingMode.trackAll;
        await context.sync();
        document.getSelection().insertText(text, word.InsertLocation.end);
        await context.sync();
      } finally {
        document.changeTrackingMode = originalMode;
        await context.sync();
      }
    });
  }
  return { createClient, readWordText, insertTrackedText };
});
