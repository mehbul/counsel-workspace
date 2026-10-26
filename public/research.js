let researchQuery = null,
  researchResults = null;
function researchPanel() {
  if (researchQuery?.matterId !== matterId) {
    researchQuery = null;
    researchResults = null;
  }
  return (
    heading(
      "PUBLIC LEGAL SOURCES",
      "Legal research",
      "Search US federal publications and dated regulations, inspect primary sources and bring them into your matter.",
      editable()
        ? '<button class="primary" onclick="newPublicationWatch()">＋ Publication watch</button>'
        : "",
    ) +
    `<div class="toolbar">${selector()}</div><p class="operations-note">Your query is sent to the selected government source. Matter documents are not sent. Current legal force and subsequent treatment are not verified.</p><form id="research-form" class="research-form"><label>Jurisdiction<select name="jurisdiction"><option value="US-federal">US federal</option></select></label><label>Source<select name="provider" id="research-provider"><option value="federal-register" ${researchQuery?.provider !== "ecfr" ? "selected" : ""}>Federal Register publications</option><option value="ecfr" ${researchQuery?.provider === "ecfr" ? "selected" : ""}>eCFR dated regulations</option></select></label><label>Search topic<input name="query" required maxlength="500" placeholder="For example: artificial intelligence" value="${esc(researchQuery?.query || "")}"></label><label data-research-fr>Published from<input type="date" name="from" value="${esc(researchQuery?.from || "")}"></label><label data-research-fr>Published through<input type="date" name="to" value="${esc(researchQuery?.to || new Date().toISOString().slice(0, 10))}"></label><label data-research-ecfr>CFR title (optional)<input name="title" type="number" min="1" max="50" value="${esc(researchQuery?.title || "")}"></label><label data-research-ecfr>Snapshot date (blank = source availability)<input type="date" name="asOf" value="${esc(researchQuery?.asOf || "")}"></label><button class="primary">Search public source</button></form><div id="research-results">${researchResults ? renderResearchResults(researchResults) : "<p>Enter a topic to search the public source.</p>"}</div><div class="sectiontitle"><h2>Publication watches</h2><button class="secondary" onclick="loadPublicationWatches()">Refresh watches</button></div><p>Federal Register watches scan while this server runs and produce in-app alerts for matching new publications. They do not cover eCFR changes, case-law treatment, every regulatory change, or external notifications.</p><div id="publication-watches">Loading…</div>`
  );
}
function sourceCard(s) {
  if (s.provider === "ecfr")
    return `<article class="workflow-card research-source"><span class="pill">Dated eCFR section</span><h3>${esc(s.citation)} — ${esc(s.title)}</h3><p>Snapshot ${esc(s.asOf)} · Source available through ${esc(s.availableAsOf || s.asOf)}</p><p>${esc(s.abstract || "Read the section source.")}</p><p><a href="${esc(s.url)}" target="_blank" rel="noopener">Dated source page ↗</a> · <a href="${esc(s.officialXml)}" target="_blank" rel="noopener">Source XML ↗</a></p><p>Editorial compilation; legal force and subsequent treatment not verified.</p>${editable() ? `<button class="secondary" onclick="importEcfrSource(${s.cfrTitle},'${s.section}','${s.asOf}',this)">Import dated section XML text</button>` : ""}</article>`;
  return `<article class="workflow-card research-source"><span class="pill">${esc(s.type)}</span><h3>${esc(s.title)}</h3><p>${esc(s.citation || s.documentNumber)} · Published ${esc(s.publicationDate)}</p><p>${esc(s.agencies.join(" · "))}</p><p>${esc(s.abstract || "No abstract supplied. Read the source document.")}</p><small>${s.effectiveOn ? "Source-reported effective date: " + esc(s.effectiveOn) : "Effective date not supplied; inspect the official document."}</small><p><a href="${esc(s.url)}" target="_blank" rel="noopener">Publication page ↗</a>${s.officialPdf ? ` · <a href="${esc(s.officialPdf)}" target="_blank" rel="noopener">Official PDF ↗</a>` : ""}</p>${editable() && s.officialPdf ? `<button class="secondary" onclick="importResearchSource('${s.documentNumber}',this)">Import official PDF text</button>` : ""}</article>`;
}
function renderResearchResults(result) {
  return `<div class="sectiontitle"><h2>${result.results.length} results on this page</h2><span>Page ${result.page} · ${result.total.toLocaleString()} reported matches</span></div><p class="operations-note">${esc(result.notice)}</p>${result.omittedOnPage ? `<p>${result.omittedOnPage} appendices, reserved, removed or unsupported results omitted on this page; reported match count includes them.</p>` : ""}<div class="research-results">${result.results.map(sourceCard).join("") || "<p>No matching publications returned. This is not a conclusion about applicable law.</p>"}</div><div class="toolbar"><button class="secondary" onclick="searchPublications(${result.page - 1})" ${result.page <= 1 ? "disabled" : ""}>Previous page</button><button class="secondary" onclick="searchPublications(${result.nextPage || 1})" ${result.nextPage ? "" : "disabled"}>Next page</button><span>Retrieved ${esc(new Date(result.retrievedAt).toLocaleString())}</span></div>`;
}
function bindResearch() {
  $("#research-form").onsubmit = (event) => {
    event.preventDefault();
    const f = new FormData(event.target);
    researchQuery = {
      matterId,
      query: f.get("query"),
      provider: f.get("provider"),
      jurisdiction: f.get("jurisdiction"),
      ...(f.get("provider") === "ecfr"
        ? {
            ...(f.get("title") ? { title: f.get("title") } : {}),
            ...(f.get("asOf") ? { asOf: f.get("asOf") } : {}),
          }
        : {
            ...(f.get("from") ? { from: f.get("from") } : {}),
            ...(f.get("to") ? { to: f.get("to") } : {}),
          }),
    };
    searchPublications(1);
  };
  const provider = $("#research-provider");
  const fields = () => {
    document
      .querySelectorAll("[data-research-fr]")
      .forEach((node) => (node.hidden = provider.value === "ecfr"));
    document
      .querySelectorAll("[data-research-ecfr]")
      .forEach((node) => (node.hidden = provider.value !== "ecfr"));
  };
  provider.onchange = fields;
  fields();
  loadPublicationWatches();
}
async function searchPublications(page) {
  if (!researchQuery || !$("#research-results")) return;
  const selected = matterId,
    request = researchQuery;
  $("#research-results").textContent = "Searching public source…";
  try {
    const result = await api(
      "research/search?" + new URLSearchParams({ ...request, page }),
      undefined,
      "GET",
    );
    if (
      view !== "research" ||
      matterId !== selected ||
      researchQuery !== request
    )
      return;
    researchResults = result;
    $("#research-results").innerHTML = renderResearchResults(result);
  } catch (error) {
    if (view === "research" && matterId === selected && $("#research-results"))
      $("#research-results").textContent = error.message;
  }
}
async function importResearchSource(documentNumber, button) {
  const selected = matterId;
  button.disabled = true;
  try {
    toast("Reading the official PDF…");
    const result = await api("research/import", {
      matterId: selected,
      documentNumber,
    });
    await refresh();
    toast(
      result.skipped
        ? "This source edition is already imported."
        : "Official PDF text imported with provenance. Verify the source before use.",
    );
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}
async function importEcfrSource(title, section, asOf, button) {
  button.disabled = true;
  try {
    const result = await api("research/import", {
      provider: "ecfr",
      matterId,
      title,
      section,
      asOf,
    });
    await refresh();
    toast(
      result.skipped
        ? "This dated section is already imported."
        : "Dated section text imported with XML provenance. Verify the source before use.",
    );
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}
function newPublicationWatch() {
  const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  formModal(
    "Create a publication watch",
    field("name", "Watch name", "US federal publication watch") +
      field(
        "query",
        "Public search query",
        "For example: artificial intelligence",
      ) +
      `<label>Start publication date<input type="date" name="from" required value="${from}"></label><label>Scan interval<select name="intervalMinutes"><option value="60">Every hour</option><option value="15">Every 15 minutes</option><option value="1440">Daily</option></select></label><p>This query will be sent to FederalRegister.gov automatically while the server is running. Existing matching publications become a baseline; alerts begin with later discoveries. Use a specific topic to keep each scan within 100 publications.</p>`,
    async (f) => {
      await api("research/watches", {
        matterId,
        name: f.get("name"),
        query: f.get("query"),
        from: f.get("from"),
        intervalMinutes: Number(f.get("intervalMinutes")),
      });
      view = "research";
    },
    "Start watch",
  );
}
async function loadPublicationWatches() {
  const selected = matterId;
  try {
    const watches = await api("research/watches", undefined, "GET");
    if (
      view !== "research" ||
      matterId !== selected ||
      !$("#publication-watches")
    )
      return;
    $("#publication-watches").innerHTML =
      watches
        .filter((w) => w.matterId === selected)
        .map(
          (w) =>
            `<article class="draft-comment"><div class="sectiontitle"><h3>${esc(w.name)}</h3><span class="pill">${w.enabled ? "Watching" : "Paused"}</span></div><p>${esc(w.query)} · Every ${w.intervalMinutes} minutes · Last scan ${esc(new Date(w.lastScanAt).toLocaleString())}</p>${w.lastError ? `<p class="autherror">${esc(w.lastError)}</p>` : ""}${editable() ? `<div class="toolbar"><button class="secondary" onclick="scanPublicationWatch('${w.id}',this)">Scan now</button><button class="secondary" onclick="togglePublicationWatch('${w.id}',${!w.enabled})">${w.enabled ? "Pause" : "Resume"}</button></div>` : ""}<div class="recentlist">${
              w.alerts
                .filter((a) => !a.dismissed)
                .map(
                  (a) =>
                    `<section class="publication-alert">${sourceCard(a.source)}${editable() ? `<button class="textbutton" onclick="dismissPublicationAlert('${w.id}','${a.id}')">Dismiss alert</button>` : ""}</section>`,
                )
                .join("") ||
              "<p>No active alerts. A completed scan does not establish complete regulatory coverage.</p>"
            }</div></article>`,
        )
        .join("") || "<p>No publication watches for this matter.</p>";
  } catch (error) {
    if ($("#publication-watches"))
      $("#publication-watches").textContent = error.message;
  }
}
async function scanPublicationWatch(id, button) {
  button.disabled = true;
  try {
    await api(`research/watches/${id}/scan`, {});
    await loadPublicationWatches();
  } catch (error) {
    toast(error.message);
    await loadPublicationWatches();
  } finally {
    button.disabled = false;
  }
}
async function togglePublicationWatch(id, enabled) {
  try {
    await api(`research/watches/${id}`, { enabled }, "PATCH");
    await loadPublicationWatches();
  } catch (error) {
    toast(error.message);
  }
}
async function dismissPublicationAlert(id, alertId) {
  try {
    await api(
      `research/watches/${id}/alerts/${alertId}`,
      { dismissed: true },
      "PATCH",
    );
    await loadPublicationWatches();
  } catch (error) {
    toast(error.message);
  }
}
