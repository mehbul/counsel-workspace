(function () {
  let client,
    mode,
    ready = false,
    busy = false;
  const $ = (id) => document.getElementById(id);
  const status = (message) => {
    $("status").textContent = message;
  };
  function update() {
    for (const id of ["read-selection", "read-document", "insert"])
      $(id).disabled = !ready || busy;
    for (const id of ["matter", "draft", "refresh-drafts", "load-draft"])
      $(id).disabled = !client || busy;
    for (const id of ["save-source", "save-draft"])
      $(id).disabled = !client || mode !== "write" || busy;
    $("connect").disabled = busy;
    $("disconnect").disabled = !client || busy;
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    update();
    try {
      await fn();
    } catch (error) {
      status(error.message || "The action failed.");
    } finally {
      busy = false;
      update();
    }
  }
  function options(id, items, label) {
    const select = $(id);
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = label;
    select.append(placeholder);
    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.title || item.name;
      select.append(option);
    }
  }
  const matterId = () => {
    const id = $("matter").value;
    if (!id) throw Error("Choose a matter.");
    return id;
  };
  async function drafts() {
    options("draft", await client.drafts(matterId()), "Choose a saved draft");
  }
  $("connect").onclick = () =>
    action(async () => {
      client?.disconnect();
      client = undefined;
      const key = $("connection-key").value.trim();
      $("connection-key").value = "";
      const candidate = CounselOffice.createClient(
        window.fetch.bind(window),
        key,
      );
      try {
        const session = await candidate.session(),
          matters = await candidate.matters();
        client = candidate;
        mode = session.mode;
        options("matter", matters, "Choose an accessible matter");
        options("draft", [], "Choose a matter");
        status(`Connected with ${mode} access to ${matters.length} matters.`);
      } catch (error) {
        candidate.disconnect();
        throw error;
      }
    });
  $("disconnect").onclick = () => {
    client?.disconnect();
    client = undefined;
    mode = undefined;
    $("connection-key").value = "";
    $("preview").value = "";
    options("matter", [], "Connect first");
    options("draft", [], "Choose a matter");
    status("Disconnected; key and preview cleared.");
    update();
  };
  $("matter").onchange = () =>
    action(async () => {
      $("preview").value = "";
      if ($("matter").value) await drafts();
      else options("draft", [], "Choose a matter");
    });
  $("refresh-drafts").onclick = () => action(drafts);
  $("load-draft").onclick = () =>
    action(async () => {
      if (!$("draft").value) throw Error("Choose a saved draft.");
      const draft = await client.readDraft(matterId(), $("draft").value);
      $("preview").value = draft.content;
      $("title").value = draft.title;
      status(
        `Draft loaded (${draft.content.length} characters). Inspect the preview and evidence in Counsel before inserting.`,
      );
    });
  for (const [id, scope] of [
    ["read-selection", "selection"],
    ["read-document", "document"],
  ])
    $(id).onclick = () =>
      action(async () => {
        $("preview").value = await CounselOffice.readWordText(Word, scope);
        status(
          "Word text is in the preview. Saving sends this text to the chosen Counsel matter.",
        );
      });
  for (const [id, method] of [
    ["save-source", "importText"],
    ["save-draft", "saveDraft"],
  ])
    $(id).onclick = () =>
      action(async () => {
        const name = $("title").value.trim(),
          text = $("preview").value;
        if (!name || !text.trim())
          throw Error("Enter a name and readable preview text.");
        const result = await client[method](
          matterId(),
          name,
          text,
          crypto.randomUUID(),
        );
        status(
          `Saved new ${id === "save-source" ? "source" : "draft"}: ${result.name || result.title || name}. The original Word document is unchanged.`,
        );
        if (id === "save-draft") await drafts();
      });
  $("insert").onclick = () =>
    action(async () => {
      await CounselOffice.insertTrackedText(
        Word,
        Office.context.requirements,
        $("preview").value,
      );
      status("Preview inserted as tracked changes. Review the result in Word.");
    });
  update();
  if (typeof Office === "undefined") {
    status(
      "Office.js could not load. Open this task pane inside a supported Word host with access to Microsoft's Office.js CDN.",
    );
    return;
  }
  Office.onReady((info) => {
    if (info.host !== Office.HostType.Word) {
      status("Open this add-in in Microsoft Word.");
      return;
    }
    ready = true;
    update();
    status(
      "Word is ready. Connect to Counsel or read your selection into the preview.",
    );
  });
})();
