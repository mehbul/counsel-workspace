let connectorList = [];
async function loadConnectors() {
  try {
    const response = await fetch("/api/connectors");
    if (!response.ok) throw Error("Unable to load integrations");
    connectorList = await response.json();
    const target = $("#connector-list");
    if (!target) return;
    target.innerHTML = `<div class="workflow-grid">${connectorList.map((c) => `<article class="workflow-card"><span class="pill">${c.provider === "microsoft" ? "Microsoft 365 / SharePoint" : "Google Drive"}</span><h2>${esc(c.name)}</h2><p>${esc(S.matters.find((m) => m.id === c.matterId)?.name || "Matter unavailable")}</p><small>${esc(c.status)}${c.last_sync ? " · " + new Date(c.last_sync).toLocaleString() : ""}</small><p>Imports a snapshot into this matter. Source permissions and deletions are not automatically mirrored.</p><footer><button class="primary" onclick="syncConnector('${c.id}')">Sync folder</button><button class="secondary" onclick="exportToConnector('${c.id}')">Export draft</button></footer><button class="textbutton" onclick="disconnectConnector('${c.id}')">Disconnect</button></article>`).join("")}</div>${!connectorList.length ? '<div class="empty"><h2>Your knowledge, connected.</h2><p>Configure a folder using credentials approved by your organization.</p></div>' : ""}<p>Imports support PDF, DOCX and text files in the selected folder, with paginated listing and optional subfolders. Native Google Docs are imported as DOCX. Source permissions and deletions are not mirrored.</p>`;
  } catch (e) {
    toast(e.message);
  }
}
function newConnector() {
  if (!S.matters.length)
    return toast("Create a matter before connecting documents.");
  modal(
    "Connect a document folder",
    `<p>Only connect an organization-approved source. Imported snapshots become available to people granted access to the selected matter. Credentials are encrypted on this server.</p><label>Provider<select id="connector-provider"><option value="microsoft">Microsoft 365 / SharePoint</option><option value="google">Google Drive</option></select></label><div id="connector-fields"></div>`,
  );
  $("#connector-provider").onchange = connectorFields;
  connectorFields();
}
function connectorFields() {
  const provider = $("#connector-provider").value;
  $("#connector-fields").innerHTML =
    `<form id="connector-form">${field("name", "Connection name", "e.g. Diligence library")}<label>Destination matter<select name="matterId">${S.matters.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("")}</select></label>${provider === "microsoft" ? field("tenantId", "Entra tenant ID") + field("clientId", "Application client ID") + field("clientSecret", "Application client secret") + field("driveId", "Drive ID") : field("clientId", "OAuth client ID") + field("clientSecret", "OAuth client secret") + field("refreshToken", "Approved OAuth refresh token")}${field("folderId", "Folder ID", provider === "microsoft" ? "Item ID or root" : "Google Drive folder ID")}<p>${provider === "microsoft" ? "Use an approved service principal with access limited to the intended SharePoint site. This app does not grant Microsoft permissions." : "Obtain a refresh token through your organization’s approved OAuth consent flow. This form does not initiate or bypass consent."}</p><label><input type="checkbox" name="recursive"> Include subfolders (bounded to 50 folders and 1,000 files)</label><div class="modalfooter"><button class="primary">Save connection</button></div></form>`;
  $("#connector-form")
    .querySelectorAll("input[name=clientSecret],input[name=refreshToken]")
    .forEach((i) => {
      i.type = "password";
      i.autocomplete = "off";
    });
  $("#connector-form").onsubmit = async (e) => {
    e.preventDefault();
    e.submitter.disabled = true;
    try {
      await api("connectors", {
        provider,
        ...Object.fromEntries(new FormData(e.target)),
        recursive: new FormData(e.target).get("recursive") === "on",
      });
      $("#modal").close();
      loadConnectors();
      toast("Connection saved. Run sync to import documents.");
    } catch (e) {
      toast(e.message);
      e.submitter.disabled = false;
    }
  };
}
async function syncConnector(id) {
  modal(
    "Import this folder?",
    `<p>Sync copies supported files from the configured source into the destination matter. People granted access to that matter can read the imported content, even if their source-system permissions differ.</p><div class="modalfooter"><button class="secondary" onclick="$('#modal').close()">Cancel</button><button class="primary" id="sync-confirm">Import documents</button></div>`,
  );
  $("#sync-confirm").onclick = async () => {
    $("#modal").close();
    try {
      const result = await api("connectors/" + id + "/sync", {});
      await refresh();
      toast(
        `${result.imported} imported · ${result.updated} new versions · ${result.skipped} skipped${result.hasMore ? " · Folder exceeds sync limit" : ""}`,
      );
      loadConnectors();
    } catch (e) {
      toast(e.message);
      loadConnectors();
    }
  };
}
function exportToConnector(id) {
  const c = connectorList.find((c) => c.id === id),
    drafts = S.drafts.filter((d) => d.matterId === c.matterId);
  if (!drafts.length)
    return toast("Create a draft in this connection’s matter first.");
  formModal(
    "Export a new document",
    `<p>This sends the selected draft to ${esc(c.name)} as a new DOCX file. It does not update the original source document.</p><label>Draft<select name="draftId">${drafts.map((d) => `<option value="${d.id}">${esc(d.title)}</option>`).join("")}</select></label>${field("filename", "Filename", "review-memorandum.docx")}`,
    async (f) => {
      await api("connectors/" + id + "/export", Object.fromEntries(f));
      toast("New DOCX exported to the connected folder.");
    },
    "Export to source",
  );
}
function disconnectConnector(id) {
  modal(
    "Disconnect integration?",
    `<p>This removes its stored credentials. Previously imported documents remain in the matter.</p><div class="modalfooter"><button class="secondary" onclick="$('#modal').close()">Cancel</button><button class="primary" id="disconnect-confirm">Disconnect</button></div>`,
  );
  $("#disconnect-confirm").onclick = async () => {
    try {
      await api("connectors/" + id, undefined, "DELETE");
      $("#modal").close();
      loadConnectors();
    } catch (e) {
      toast(e.message);
    }
  };
}
