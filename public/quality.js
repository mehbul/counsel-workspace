let activeComparison,
  reviewFilters = { id: null, query: "", status: "all", sort: "name", page: 0 };
const chatSourceSelection = {};
function reviewPanel(r) {
  if (reviewFilters.id !== r.id)
    reviewFilters = {
      id: r.id,
      query: "",
      status: "all",
      sort: "name",
      page: 0,
    };
  return `<div class="review-summary"><span class="dot"></span>${esc(r.mode || "Ranked passage extraction")}<span>${r.cells.filter((c) => c.reviewed).length}/${r.cells.length} findings reviewed</span></div><div class="toolbar review-filterbar"><input aria-label="Filter review findings" placeholder="Filter document names or findings…" value="${esc(reviewFilters.query)}" oninput="filterReview('query',this.value)"><select aria-label="Filter review status" onchange="filterReview('status',this.value)">${[
    ["all", "All findings"],
    ["unreviewed", "Needs review"],
    ["reviewed", "Reviewed"],
    ["locked", "Locked"],
  ]
    .map(
      ([v, t]) =>
        `<option value="${v}" ${reviewFilters.status === v ? "selected" : ""}>${t}</option>`,
    )
    .join(
      "",
    )}</select><select aria-label="Sort review documents" onchange="filterReview('sort',this.value)"><option value="name" ${reviewFilters.sort === "name" ? "selected" : ""}>Document name</option><option value="open" ${reviewFilters.sort === "open" ? "selected" : ""}>Most unreviewed first</option></select></div><div id="review-results">${reviewResults(r)}</div>`;
}
function reviewResults(r) {
  let rows = [...new Set(r.cells.map((c) => c.documentId))].map((id) => ({
    id,
    name: S.documents.find((d) => d.id === id)?.name || "Unavailable source",
    cells: r.cells.filter((c) => c.documentId === id),
  }));
  const q = reviewFilters.query.trim().toLowerCase();
  rows = rows.filter(
    (row) =>
      (!q ||
        row.name.toLowerCase().includes(q) ||
        row.cells.some((c) => c.value.toLowerCase().includes(q))) &&
      (reviewFilters.status === "all" ||
        row.cells.some((c) =>
          reviewFilters.status === "locked"
            ? c.locked
            : reviewFilters.status === "reviewed"
              ? c.reviewed
              : !c.reviewed,
        )),
  );
  rows.sort((a, b) =>
    reviewFilters.sort === "open"
      ? b.cells.filter((c) => !c.reviewed).length -
          a.cells.filter((c) => !c.reviewed).length ||
        a.name.localeCompare(b.name)
      : a.name.localeCompare(b.name),
  );
  const pageSize = 25,
    last = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  reviewFilters.page = Math.min(last, Math.max(0, reviewFilters.page));
  const shown = rows.slice(
    reviewFilters.page * pageSize,
    (reviewFilters.page + 1) * pageSize,
  );
  return `<div class="comparison-meta"><span>${rows.length} matching documents · rows match any finding</span><div><button class="secondary" onclick="reviewPage(-1)" ${reviewFilters.page === 0 ? "disabled" : ""}>Previous</button> <span>Page ${reviewFilters.page + 1} of ${last + 1}</span> <button class="secondary" onclick="reviewPage(1)" ${reviewFilters.page === last ? "disabled" : ""}>Next</button></div></div><div class="tablewrap"><table class="reviewtable"><caption class="sr-only">Evidence review findings</caption><thead><tr><th>Document</th>${r.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${
    shown
      .map(
        (row) =>
          `<tr><th>${esc(row.name)}</th>${r.columns
            .map((_, i) => {
              const c = row.cells.find((c) => c.column === i);
              return c
                ? `<td><button class="cell ${c.reviewed ? "reviewed" : ""}" onclick="inspectCell('${r.id}','${c.id}')">${c.reviewed ? '<span class="reviewcheck">✓ Reviewed</span>' : ""}${esc(c.value.slice(0, 650))}${c.value.length > 650 ? "…" : ""}<small>${c.locked ? "▣ Locked" : "↗ " + c.citations.length + " sources"}</small></button></td>`
                : "<td>No finding</td>";
            })
            .join("")}</tr>`,
      )
      .join("") ||
    `<tr><td colspan="${r.columns.length + 1}">No documents match these filters.</td></tr>`
  }</tbody></table></div>`;
}
function filterReview(key, value) {
  reviewFilters[key] = value;
  reviewFilters.page = 0;
  const r = S.reviews.find((r) => r.id === reviewFilters.id);
  if (r && $("#review-results"))
    $("#review-results").innerHTML = reviewResults(r);
}
function reviewPage(delta) {
  reviewFilters.page += delta;
  const r = S.reviews.find((r) => r.id === reviewFilters.id);
  if (r && $("#review-results"))
    $("#review-results").innerHTML = reviewResults(r);
}
function chooseAssistantSources() {
  const selected = chatSourceSelection[matterId];
  modal(
    "Choose Assistant sources",
    `<p>Only selected current documents will be searched for this matter. Existing conversations keep their original references.</p><form id="chat-sources"><fieldset class="source-checks"><legend>Documents</legend>${
      docs()
        .map(
          (d) =>
            `<label><input type="checkbox" name="source" value="${d.id}" ${!selected || selected.includes(d.id) ? "checked" : ""}>${esc(d.name)}</label>`,
        )
        .join("") || "<p>No current source documents.</p>"
    }</fieldset><button class="primary">Use selected sources</button><button type="button" class="secondary" onclick="delete chatSourceSelection[matterId];$('#modal').close();render()">Use all current sources</button></form>`,
  );
  $("#chat-sources").onsubmit = (e) => {
    e.preventDefault();
    const ids = new FormData(e.target).getAll("source");
    if (docs().length && !ids.length)
      return toast("Select at least one source, or use all current sources.");
    chatSourceSelection[matterId] = ids;
    $("#modal").close();
    render();
  };
}
async function inspectReferences(kind, id, cellId) {
  try {
    const url =
      kind === "review-cell"
        ? `reviews/${id}/cells/${cellId}/evidence`
        : `${kind}/${id}/evidence`;
    const r = await api(url, undefined, "GET");
    modal(
      "Source reference checks",
      `<p class="reference-status ${r.status === "references_valid" ? "matched" : ""}">${r.status === "references_valid" ? "Linked references match their sources" : r.status === "no_sources" ? "No source references supplied" : "References need attention"}</p><div class="reference-stats"><strong>${r.validCitationCount}/${r.citationCount} quoted sources matched</strong>${r.checkedOutputText === false ? "" : `<span>${r.uncitedParagraphCount} output paragraphs without matching inline references</span>`}</div><p class="operations-note">${esc(r.limitation)}</p>${r.checkedOutputText === false ? "<p>Only linked source quotations were checked. The interpretation in this finding was not evaluated.</p>" : ""}<div class="recentlist">${r.issues.map((i) => `<article class="draft-comment"><strong>${esc(i.severity)}${i.citation ? " · reference " + i.citation : ""}</strong><p>${esc(i.message)}</p></article>`).join("") || "<p>No reference-integrity issues found. A lawyer still needs to assess the interpretation and source currency.</p>"}</div>${r.uncitedParagraphs.length ? `<h3>Passages to review</h3>${r.uncitedParagraphs.map((p) => `<blockquote>${esc(p.text)}</blockquote>`).join("")}` : ""}`,
    );
  } catch (e) {
    toast(e.message);
  }
}
function newComparison() {
  const sources = S.documents.filter((d) => d.matterId === matterId);
  if (sources.length < 2)
    return toast("Import at least two source documents first.");
  formModal(
    "Compare source documents",
    field("name", "Comparison name", "Contract comparison") +
      `<label>Questions — one per line<textarea name="questions" required>Governing law\nLiability cap\nAssignment restrictions\nTermination</textarea></label><fieldset class="source-checks"><legend>Select two to six source versions</legend>${sources.map((d, i) => `<label><input type="checkbox" name="documentIds" value="${d.id}" ${i < 2 ? "checked" : ""}>${esc(d.name)} ${d.supersededBy ? "· previous version" : ""}</label>`).join("")}</fieldset><p>The first two sources are used for highlighted wording changes. Every selected source appears in the coverage table.</p>`,
    async (f) => {
      const r = await api("comparisons", {
        matterId,
        name: f.get("name"),
        documentIds: f.getAll("documentIds"),
        questions: f
          .get("questions")
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
      });
      activeComparison = r.id;
      view = "compare";
    },
    "Compare",
  );
}
async function loadComparisons() {
  const currentMatter = matterId;
  try {
    const reports = await api("comparisons", undefined, "GET");
    if (view !== "compare" || matterId !== currentMatter) return;
    const list = reports.filter((r) => r.matterId === matterId),
      active = list.find((r) => r.id === activeComparison) || list[0];
    if (!active) {
      $("#comparison-content").innerHTML = empty(
        "⇆",
        "See what changed.",
        "Select documents and questions to compare their source evidence.",
        editable() ? "Create comparison" : "",
        "newComparison()",
      );
      return;
    }
    activeComparison = active.id;
    const report = await api("comparisons/" + active.id, undefined, "GET");
    if (
      view !== "compare" ||
      matterId !== currentMatter ||
      activeComparison !== active.id
    )
      return;
    $("#comparison-content").innerHTML =
      `<div class="toolbar"><select aria-label="Select comparison" onchange="activeComparison=this.value;loadComparisons()">${list.map((r) => `<option value="${r.id}" ${r.id === active.id ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select><a class="secondary" href="/api/comparisons/${active.id}/export">↓ Export comparison CSV</a><span>${report.documents.length} source versions · ${report.rows.length} questions</span></div><p class="operations-note">${esc(report.notice)}</p>${report.unavailableSources?.length ? '<p class="autherror">One or more source documents are no longer available. Saved excerpts remain, but source opening may fail.</p>' : ""}${report.rows.map((row) => `<section class="comparison-section"><div class="sectiontitle"><h2>${esc(row.question)}</h2><span class="pill">${row.coverage.matched}/${row.coverage.total} sources matched</span></div><div class="comparison-grid">${row.findings.map((f) => `<article class="comparison-source"><h3>${esc(f.documentName)}</h3>${f.sources.length ? f.sources.map((c) => `<blockquote>${esc(c.text)}<button class="textbutton" onclick="showDoc('${c.documentId}',${c.paragraph})">Open paragraph ${c.paragraph} ↗</button></blockquote>`).join("") : '<p class="missing-evidence">No matching passage found. Inspect the source before concluding that a provision is absent.</p>'}</article>`).join("")}</div>${row.diff ? `<details class="comparison-diff"><summary>${row.diff.equal ? "First two matching passages use identical wording" : "Show wording changes between the first two passages"}${row.diff.truncated ? " · excerpt comparison only" : ""}</summary><div>${row.diff.parts.map((p) => (p.kind === "added" ? `<ins>${esc(p.text)}</ins>` : p.kind === "removed" ? `<del>${esc(p.text)}</del>` : esc(p.text))).join("")}</div></details>` : ""}</section>`).join("")}`;
  } catch (e) {
    if ($("#comparison-content"))
      $("#comparison-content").textContent = e.message;
  }
}
