// Staff publication controls and a separate guest-only application shell.
function portalPanel() {
  const writable = ["owner", "editor"].includes(authState?.user?.role);
  return (
    heading(
      "CLIENT DELIVERY",
      "Client portal",
      "Publish only the documents and reviewed work your clients should see.",
      writable
        ? '<div><button class="secondary" onclick="publishPortalText()">Publish reviewed text</button> <button class="primary" onclick="publishPortalDocument()">Publish document</button></div>'
        : "",
    ) +
    `<div class="toolbar">${selector()}<a class="secondary" href="/portal.html" target="_blank" rel="noopener">Guest sign-in ↗</a></div><p class="operations-note">Owners create client guest accounts and assign matters in Account. A guest also needs an explicit publication for each item. Publication creates a plain-text snapshot; later edits are not shared automatically.</p><div id="portal-manager"><p>Loading publications…</p></div>`
  );
}
async function loadPortalManager() {
  const selectedMatter = matterId;
  try {
    const publications = await api("portal/manage", undefined, "GET");
    if (
      view !== "portal" ||
      matterId !== selectedMatter ||
      !$("#portal-manager")
    )
      return;
    $("#portal-manager").innerHTML = `<div class="recentlist">${
      publications
        .filter((p) => p.matterId === selectedMatter)
        .map(
          (p) =>
            `<article class="draft-comment"><strong>${esc(p.title)}</strong><p>${p.kind === "document" ? "Document snapshot" : "Reviewed text"} · ${p.recipientIds.length} recipients · ${esc(new Date(p.created).toLocaleString())}</p><small>${p.revoked ? "Revoked — unavailable to guests" : !p.sourceAvailable ? "Source unavailable — hidden from guests" : "Published to selected client guests"}</small>${!p.revoked ? `<p><button class="secondary" onclick="revokePortalPublication('${p.id}')">Revoke publication</button></p>` : ""}</article>`,
        )
        .join("") || "<p>No publications for this matter.</p>"
    }</div>`;
  } catch (e) {
    if ($("#portal-manager")) $("#portal-manager").textContent = e.message;
  }
}
async function portalPublicationForm(kind) {
  const selectedMatter = matterId;
  try {
    const recipients = await api(
      "portal/recipients?matterId=" + encodeURIComponent(selectedMatter),
      undefined,
      "GET",
    );
    if (matterId !== selectedMatter) return;
    if (!recipients.length)
      return toast(
        "Ask an owner to create a client guest and grant access to this matter first.",
      );
    const sources = S.documents.filter((d) => d.matterId === selectedMatter);
    if (kind === "document" && !sources.length)
      return toast("Import a source document first.");
    formModal(
      kind === "document"
        ? "Publish a document snapshot"
        : "Publish reviewed text",
      field("title", "Client-facing title") +
        (kind === "document"
          ? `<label>Document<select name="documentId">${sources.map((d) => `<option value="${d.id}">${esc(d.name)}${d.supersededBy ? " · previous version" : ""}</option>`).join("")}</select></label><p>Up to 200,000 characters. This publishes the full extracted text, without original formatting.</p><details><summary>Review document text before sharing</summary><div class="portal-content" id="portal-document-preview">${esc(sources[0].text.slice(0, 200000))}</div></details>`
          : '<label>Reviewed work<textarea name="content" required maxlength="200000" aria-label="Reviewed work"></textarea></label>') +
        `<fieldset class="source-checks"><legend>Client recipients</legend>${recipients.map((u) => `<label><input type="checkbox" name="recipientIds" value="${u.id}"> ${esc(u.email)}</label>`).join("")}</fieldset><label><input type="checkbox" name="confirmedReviewed" required> I have reviewed this content and confirm it is ready to share with the selected recipients.</label><p>Recipients can read this snapshot until publication is revoked or their account/matter access is removed.</p>`,
      async (f) => {
        await api("portal/manage", {
          matterId: selectedMatter,
          kind,
          title: f.get("title"),
          recipientIds: f.getAll("recipientIds"),
          confirmedReviewed: f.get("confirmedReviewed") === "on",
          ...(kind === "document"
            ? { documentId: f.get("documentId") }
            : { content: f.get("content") }),
        });
      },
      "Publish to selected clients",
    );
    if (kind === "document")
      $("#modal select[name=documentId]").onchange = (e) => {
        $("#portal-document-preview").textContent = sources
          .find((d) => d.id === e.target.value)
          .text.slice(0, 200000);
      };
  } catch (e) {
    toast(e.message);
  }
}
function publishPortalDocument() {
  return portalPublicationForm("document");
}
function publishPortalText() {
  return portalPublicationForm("reviewed_text");
}
async function revokePortalPublication(id) {
  try {
    await api(`portal/manage/${id}/revoke`, {});
    await loadPortalManager();
    toast("Publication revoked. Future guest reads are blocked.");
  } catch (e) {
    toast(e.message);
  }
}
function portalEscape(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
let clientPortalItems = [];
async function clientPortalApi(
  url,
  body,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await fetch("/api/" + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": authState?.csrf || "",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) {
    if (r.status === 401) {
      await loadSession();
      authScreen();
    }
    throw Error(data.error || "Unable to load client portal.");
  }
  return data;
}
function clientPortalToast(message) {
  const node = document.querySelector("#toast");
  node.textContent = message;
  node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 4000);
}
async function clientPortalRefresh() {
  const data = await clientPortalApi("portal/items");
  clientPortalItems = data.items;
}
function clientPortalRender() {
  if (!authState?.user || authState.user.role !== "guest") return;
  document.querySelector("#app").innerHTML =
    `<div class="portal-shell"><div class="portal-header"><div><a class="brand" href="/portal.html"><span class="brandmark">c</span>${portalEscape(authState.user.workspace)}</a><p>Client portal · ${portalEscape(authState.user.email)}</p></div><div><button class="secondary" onclick="clientPortalReload()">Refresh</button> <button class="secondary" onclick="clientPortalPassword()">Change password</button> <button class="primary" onclick="logout()">Sign out</button></div></div><div class="eyebrow">SHARED WITH YOU</div><h1>Your published documents</h1><p>Read the documents and reviewed work shared with your account.</p><div class="recentlist">${clientPortalItems.map((p) => `<article class="draft-comment"><h2>${portalEscape(p.title)}</h2><p>${p.kind === "document" ? "Document snapshot" : "Reviewed work"} · ${portalEscape(new Date(p.created).toLocaleString())}</p><button class="secondary" onclick="clientPortalOpen('${p.id}')">Read published item</button></article>`).join("") || "<p>No items are currently shared with your account.</p>"}</div></div>`;
}
async function clientPortalReload() {
  try {
    await clientPortalRefresh();
    clientPortalRender();
  } catch (e) {
    clientPortalToast(e.message);
  }
}
async function clientPortalOpen(id) {
  try {
    const item = await clientPortalApi("portal/items/" + id);
    const dialog = document.querySelector("#modal");
    dialog.innerHTML = `<div class="modalheader"><h2>${portalEscape(item.title)}</h2><button aria-label="Close dialog" onclick="document.querySelector('#modal').close()">×</button></div><p>Published plain-text snapshot · ${portalEscape(new Date(item.created).toLocaleString())}</p><div class="portal-content">${portalEscape(item.content)}</div>`;
    dialog.showModal();
  } catch (e) {
    clientPortalToast(e.message);
  }
}
function clientPortalPassword() {
  const dialog = document.querySelector("#modal");
  dialog.innerHTML =
    '<div class="modalheader"><h2>Change password</h2><button aria-label="Close dialog" onclick="document.querySelector(\'#modal\').close()">×</button></div><form id="portal-password"><label>Current password<input type="password" name="currentPassword" required autocomplete="current-password"></label><label>New password<input type="password" name="password" required minlength="14" maxlength="256" autocomplete="new-password"></label><p>At least 14 characters. Your other sessions will be signed out.</p><button class="primary">Change password</button></form>';
  dialog.showModal();
  document.querySelector("#portal-password").onsubmit = async (e) => {
    e.preventDefault();
    const button = e.submitter;
    button.disabled = true;
    try {
      const result = await clientPortalApi(
        "auth/password",
        Object.fromEntries(new FormData(e.target)),
      );
      authState.csrf = result.csrf;
      dialog.close();
      clientPortalToast("Password changed.");
    } catch (err) {
      clientPortalToast(err.message);
    } finally {
      button.disabled = false;
    }
  };
}
if (document.body.dataset.portal === "guest") {
  // auth.js uses these shared presentation functions without loading the staff app.
  window.$ = (selector) => document.querySelector(selector);
  window.esc = portalEscape;
  window.api = clientPortalApi;
  window.toast = clientPortalToast;
  window.refresh = clientPortalRefresh;
  window.render = clientPortalRender;
  window.view = "portal";
  loadSession()
    .then(async (signedIn) => {
      if (!signedIn) return authScreen();
      await clientPortalRefresh();
      clientPortalRender();
    })
    .catch(() => {
      document.querySelector("#app").textContent =
        "Unable to load the client portal. Reload to try again.";
    });
}
