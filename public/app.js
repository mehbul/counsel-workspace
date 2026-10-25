let S,
  view = "home",
  matterId,
  activeReview,
  activeDraft,
  busy = false;
const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const icons = {
  home: "⌂",
  assistant: "✳",
  matters: "▣",
  documents: "▤",
  review: "▦",
  editor: "▧",
  workflows: "⌘",
  intake: "↳",
  monitors: "◉",
  skills: "◇",
  tasks: "☷",
  integrations: "⇄",
  activity: "◷",
};
async function api(url, body, method = "POST") {
  const r = await fetch("/api/" + url, {
    method,
    headers: {
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      "X-CSRF-Token": authState?.csrf || "",
      Prefer: ["reviews", "drafts"].includes(url) ? "respond-async" : "",
    },
    body:
      body instanceof FormData
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "Request failed");
  if (r.status !== 202) return d;
  sessionStorage.setItem("pendingRun", JSON.stringify({ jobId: d.jobId, url }));
  toast("Run queued. You can reload safely.");
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const response = await fetch("/api/jobs/" + d.jobId),
      job = await response.json();
    if (!response.ok) throw Error(job.error || "Run unavailable");
    if (job.status === "failed") {
      sessionStorage.removeItem("pendingRun");
      throw Error(job.error);
    }
    if (job.status === "completed") {
      sessionStorage.removeItem("pendingRun");
      return job.result;
    }
  }
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), 4000);
}
async function refresh() {
  const r = await fetch("/api/state");
  if (r.status === 401) {
    await loadSession();
    authScreen();
    throw Error("Session expired. Sign in again.");
  }
  if (!r.ok) throw Error("Unable to load workspace");
  S = await r.json();
  matterId = S.matters.some((m) => m.id === matterId)
    ? matterId
    : S.matters[0]?.id;
}
const docs = () =>
    S.documents.filter((d) => d.matterId === matterId && !d.supersededBy),
  matter = () => S.matters.find((m) => m.id === matterId);
function go(next) {
  view = next;
  render();
}
function render() {
  window.CounselCollab?.detach();
  clearTimeout(workflowPoll);
  const nav = [
    ["home", "Home"],
    ["assistant", "Assistant"],
    ["matters", "Matters"],
    ["documents", "Documents"],
    ["review", "Tabular review"],
    ["editor", "Editor"],
    ["workflows", "Workflows"],
    ["intake", "Intake"],
    ["monitors", "Monitors"],
    ["skills", "Skills"],
    ["tasks", "Lists"],
    ...(authState?.user?.role === "owner"
      ? [["integrations", "Integrations"]]
      : []),
    ["activity", "Activity"],
  ];
  $("#app").innerHTML =
    `<aside><a class="brand" href="#" onclick="go('home');return false"><span class="brandmark">c</span>counsel<span class="beta">WORKSPACE</span></a><div class="workspace"><span class="avatar">CL</span><div>${esc(authState?.user?.workspace)}<small>${esc(authState?.user?.role)} access</small></div></div><button class="newchat" onclick="go('assistant')">＋ New conversation</button><nav>${nav.map(([v, label]) => `<button class="${view === v ? "selected" : ""}" onclick="go('${v}')"><span>${icons[v]}</span>${label}</button>`).join("")}</nav><div class="aside-bottom"><div class="local-note"><span class="dot"></span>${esc(S.aiLabel || (S.aiAvailable ? "AI provider configured" : "Local evidence mode"))}<small>Grounded in your documents</small></div><button class="profile accountbutton" onclick="account()"><span class="avatar">Y</span><div>${esc(authState?.user?.email)}<small>Account and workspace settings</small></div></button></div></aside><main><header><div class="breadcrumbs">Workspace <span>/</span>${esc(nav.find((n) => n[0] === view)?.[1])}</div><div class="header-right"><span class="privacy">◈ Private workspace</span><button class="avatar tiny" onclick="account()" aria-label="Account">Y</button></div></header><div class="page ${view === "assistant" ? "chatpage" : ""}">${content()}</div></main>`;
  bind();
}
function heading(k, title, sub, action = "") {
  return `<div class="pageheading"><div><div class="eyebrow">${k}</div><h1>${title}</h1><p>${sub}</p></div>${action}</div>`;
}
function selector() {
  return `<select id="matter-select" aria-label="Current matter">${S.matters.map((m) => `<option value="${m.id}" ${m.id === matterId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>`;
}
function empty(icon, title, description, label, fn) {
  return `<div class="empty"><span>${icon}</span><h2>${title}</h2><p>${description}</p>${label ? `<button class="primary" onclick="${fn}">${label}</button>` : ""}</div>`;
}
function cards() {
  return S.matters
    .map(
      (m) =>
        `<button class="mattercard" onclick="matterId='${m.id}';go('documents')"><span class="folder">▣</span><span class="pill">Active</span><h3>${esc(m.name)}</h3><p>${esc(m.description || m.client || "Legal matter")}</p><footer><span>${S.documents.filter((d) => d.matterId === m.id && !d.supersededBy).length} documents</span><span>Open matter →</span></footer></button>`,
    )
    .join("");
}
function content() {
  switch (view) {
    case "home":
      return `<div class="welcome"><div class="eyebrow">YOUR LEGAL WORKSPACE</div><h1>Good work starts here.</h1><p>A little less groundwork. A little more perspective.</p></div><div class="home-prompt"><span class="spark">✳</span><textarea id="home-query" placeholder="What would you like to work on today?" aria-label="Ask the assistant"></textarea><div><span>▣ ${esc(matter()?.name || "Create a matter to begin")}</span><button class="send" id="home-send" aria-label="Send question">↑</button></div></div><div class="quick-actions">${[
        ["review", "▦", "Review documents", "Find the details that matter."],
        ["editor", "▧", "Draft with context", "Turn your findings into work."],
        [
          "workflows",
          "⌘",
          "Run a workflow",
          "Make your best process repeatable.",
        ],
      ]
        .map(
          ([v, i, t, d]) =>
            `<button onclick="go('${v}')"><span>${i}</span><strong>${t}</strong><small>${d}</small><b>↗</b></button>`,
        )
        .join(
          "",
        )}</div><div class="sectiontitle"><h2>Your matters</h2><button class="textbutton" onclick="go('matters')">View all matters →</button></div><div class="mattercards">${cards()}<button class="addmatter" onclick="newMatter()">＋<strong>Create a matter</strong><small>Bring your work together</small></button></div><div class="sectiontitle"><h2>Continue where you left off</h2><span class="muted">All changes saved</span></div>${documentList(S.documents.filter((d) => !d.supersededBy).slice(0, 3))}`;
    case "matters":
      return (
        heading(
          "ORGANIZE",
          "Matters",
          "A dedicated space for every client and every question.",
          '<button class="primary" onclick="newMatter()">＋ New matter</button>',
        ) + `<div class="mattercards">${cards()}</div>`
      );
    case "documents":
      return (
        heading(
          "MATTER DOCUMENTS",
          "Your source of truth.",
          "Import documents and keep analysis grounded.",
          '<button class="primary" onclick="uploadDocuments()">＋ Upload documents</button>',
        ) +
        `<div class="toolbar">${selector()}<input id="doc-search" placeholder="Search documents…" aria-label="Search documents"><span>${docs().length} current documents</span></div><input id="upload" type="file" multiple hidden accept=".pdf,.docx,.txt,.md,.csv"><div class="uploadzone" onclick="uploadDocuments()"><span>⇧</span><strong>Add documents to ${esc(matter()?.name || "a matter")}</strong><small>PDF, DOCX, TXT, Markdown or CSV · five files, 20 MB each</small></div><div id="document-list">${documentList(docs())}</div>`
      );
    case "assistant":
      return `<div class="chat-top"><div><h2>Assistant <span class="pill">${S.aiAvailable ? "AI configured" : "Evidence search"}</span></h2><p>Grounded in your matter. Linked to the source.</p></div>${selector()}</div><div class="conversation">${
        S.messages.filter((m) => m.matterId === matterId).length
          ? S.messages
              .filter((m) => m.matterId === matterId)
              .map(
                (m) =>
                  `<div class="userbubble">${esc(m.query)}</div><article class="answer"><span class="answer-mark">✳</span><div><small>${esc(m.mode)}</small><div class="answertext">${esc(m.text)}</div><div class="citations">${m.citations.map((c, i) => `<button onclick="showDoc('${c.documentId}',${c.paragraph})">[${i + 1}] ${esc(c.name)} ↗</button>`).join("")}</div></div></article>`,
              )
              .join("")
          : `<div class="chat-empty"><span>✳</span><h1>A second perspective.<br>On your terms.</h1><p>Ask about clauses, compare agreements, or find the evidence.</p><div class="suggestions">${["What are the governing law provisions?", "Compare liability across the agreements", "Find assignment restrictions"].map((q) => `<button onclick="$('#query').value=this.textContent">${q}</button>`).join("")}</div></div>`
      }</div><form id="chat-form" class="composer"><textarea id="query" required placeholder="Ask about your documents…" aria-label="Your question"></textarea><div><span>▤ ${docs().length} documents</span><select id="skill-select" aria-label="Apply a skill"><option value="">◇ Apply a skill</option>${S.skills.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select><button class="send" aria-label="Send question" ${busy ? "disabled" : ""}>${busy ? "…" : "↑"}</button></div></form><p class="composer-note">${S.aiAvailable ? "Verify generated results against source passages." : "Local mode returns source excerpts. A configured AI provider enables generated analysis."}</p>`;
    case "review": {
      const reviews = S.reviews.filter((r) => r.matterId === matterId),
        r = reviews.find((r) => r.id === activeReview) || reviews[0];
      return (
        heading(
          "ANALYZE AT SCALE",
          "Tabular review",
          "Every finding connected to evidence.",
          '<button class="primary" onclick="newReview()">＋ New review</button>',
        ) +
        `<div class="toolbar">${selector()}${r ? `<select id="review-select" aria-label="Select review">${reviews.map((x) => `<option value="${x.id}" ${x.id === r.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select><button class="secondary" onclick="exportReview('${r.id}')">↓ Export CSV</button>` : ""}</div>${
          r
            ? `<div class="review-summary"><span class="dot"></span>Extraction complete <span>${r.cells.filter((c) => c.reviewed).length}/${r.cells.length} findings reviewed</span><small>${esc(r.mode || "Local passage extraction")} · select a cell to inspect evidence</small></div><div class="tablewrap"><table class="reviewtable"><thead><tr><th>Document</th>${r.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${[
                ...new Set(r.cells.map((c) => c.documentId)),
              ]
                .map(
                  (did) =>
                    `<tr><th><span class="docicon">▤</span>${esc(S.documents.find((d) => d.id === did)?.name || "Deleted document")}</th>${r.columns
                      .map((_, i) => {
                        const c = r.cells.find(
                          (c) => c.documentId === did && c.column === i,
                        );
                        return `<td><button class="cell ${c.reviewed ? "reviewed" : ""}" onclick="inspectCell('${r.id}','${c.id}')">${c.reviewed ? '<span class="reviewcheck">✓ Reviewed</span>' : ""}${esc(c.value)}<small>${c.locked ? "▣ Locked" : "↗ " + c.citations.length + " sources"}</small></button></td>`;
                      })
                      .join("")}</tr>`,
                )
                .join("")}</tbody></table></div>`
            : empty(
                "▦",
                "A clearer view of every document.",
                "Extract clauses into a comparison table.",
                "Create review",
                "newReview()",
              )
        }`
      );
    }
    case "editor": {
      const drafts = S.drafts.filter((d) => d.matterId === matterId),
        d = drafts.find((d) => d.id === activeDraft) || drafts[0];
      return (
        heading(
          "FROM FINDINGS TO WORK PRODUCT",
          "Editor",
          "Draft together, refine your findings, and export to Word.",
          '<button class="primary" onclick="newDraft()">＋ New draft</button>',
        ) +
        `<div class="toolbar">${selector()}${d ? `<select id="draft-select" aria-label="Select draft">${drafts.map((x) => `<option value="${x.id}" ${x.id === d.id ? "selected" : ""}>${esc(x.title)}</option>`).join("")}</select><button class="secondary" onclick="saveDraft('${d.id}')">Save title</button><a class="primary" href="/api/drafts/${d.id}/export">↓ Export Word</a>` : ""}</div>${d ? `<div class="editorpaper"><input id="draft-title" value="${esc(d.title)}" aria-label="Draft title"><div class="rich-actions"><button class="secondary" onclick="draftSuggestions('${d.id}')">Proposed edits</button><button class="secondary" onclick="draftComments('${d.id}')">Comments</button><button class="secondary" onclick="draftHistory('${d.id}')">History</button><button class="secondary" onclick="CounselCollab.undo()">↶ Undo</button><button class="secondary" onclick="CounselCollab.redo()">↷ Redo</button></div><div id="draft-content"></div><small id="collaboration-status">Connecting to shared draft…</small></div>` : empty("▧", "Room for your next great argument.", "Create a draft from your matter documents.", "Create draft", "newDraft()")}`
      );
    }
    case "workflows":
    case "intake":
    case "monitors": {
      const titles = {
          workflows: [
            "REPEAT YOUR BEST WORK",
            "Workflows",
            "Run your process from evidence to approved work product.",
            "editWorkflow()",
            "＋ Create workflow",
          ],
          intake: [
            "KEEP REQUESTS ACCOUNTABLE",
            "Intake",
            "Give every legal request an owner and an approved resolution.",
            "newIntake()",
            "＋ New request",
          ],
          monitors: [
            "KEEP UP WITH YOUR MATTER",
            "Monitors",
            "Turn new document evidence into follow-up work.",
            "newMonitor()",
            "＋ Create monitor",
          ],
        },
        t = titles[view];
      return (
        heading(
          t[0],
          t[1],
          t[2],
          editable()
            ? `<button class="primary" onclick="${t[3]}">${t[4]}</button>`
            : "",
        ) +
        `<div class="toolbar">${selector()}<button class="secondary" onclick="loadWorkflowViews()">Refresh</button></div><div id="workflow-content">Loading…</div>`
      );
    }
    case "skills":
      return (
        heading(
          "YOUR KNOWLEDGE, REUSABLE",
          "Skills",
          "Bring your standards into every conversation.",
          '<button class="primary" onclick="newSkill()">＋ Create skill</button>',
        ) +
        `<div class="workflow-grid">${S.skills.map((s) => `<article class="workflow-card"><div class="workflow-icon">◇</div><span class="pill">${esc(s.category)} · v${s.version || 1}</span><h2>${esc(s.name)}</h2><p>${esc(s.instructions)}</p><button class="textbutton" onclick="go('assistant');$('#skill-select').value='${s.id}'">Use in Assistant →</button><div class="rich-actions">${editable() ? `<button class="secondary" onclick="editSkill('${s.id}')">Edit skill</button>` : ""}<button class="secondary" onclick="skillHistory('${s.id}')">Version history</button></div></article>`).join("")}</div>`
      );
    case "tasks":
      return (
        heading(
          "KEEP WORK MOVING",
          "Lists",
          "Give every follow-up a next step.",
          '<button class="primary" onclick="newTask()">＋ Add task</button>',
        ) +
        `<div class="toolbar">${selector()}</div><div class="board">${[
          "To do",
          "In progress",
          "Done",
        ]
          .map(
            (status) =>
              `<section><h3>${status}<span>${S.tasks.filter((t) => t.matterId === matterId && t.status === status).length}</span></h3>${S.tasks
                .filter((t) => t.matterId === matterId && t.status === status)
                .map(
                  (t) =>
                    `<article class="taskcard"><strong>${esc(t.title)}</strong><small>◉ ${esc(t.owner)}</small><select aria-label="Task status" onchange="updateTask('${t.id}',this.value)">${["To do", "In progress", "Done"].map((s) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select></article>`,
                )
                .join("")}</section>`,
          )
          .join("")}</div>`
      );
    case "integrations":
      return (
        heading(
          "CONNECTED KNOWLEDGE",
          "Integrations",
          "Bring approved document sources into a controlled matter.",
          '<button class="primary" onclick="newConnector()">＋ Connect a folder</button>',
        ) + '<div id="connector-list">Loading integrations…</div>'
      );
    case "activity":
      return (
        heading(
          "WORKSPACE HISTORY",
          "Activity",
          "A record of changes in this workspace.",
        ) +
        `<div class="recentlist">${S.activity.map((a) => `<div class="activityrow"><span>◷</span><strong>${esc(a.action)}</strong><small>${new Date(a.date).toLocaleString()}</small></div>`).join("") || '<p class="muted">Activity appears here for workspace owners.</p>'}</div>`
      );
  }
}
function documentList(list) {
  return `<div class="recentlist">${list.map((d) => `<div class="docrow"><button onclick="showDoc('${d.id}')"><span class="docicon">▤</span><div><strong>${esc(d.name)}</strong><small>${d.sample ? "Sample · " : ""}${d.text.length.toLocaleString()} characters · ${d.source ? "Connected source" : "Ready"}</small></div></button><button class="textbutton" onclick="deleteDoc('${d.id}')" aria-label="Delete ${esc(d.name)}">×</button></div>`).join("") || '<p class="muted">No documents found.</p>'}</div>`;
}
function modal(title, html) {
  $("#modal").innerHTML =
    `<div class="modalheader"><h2>${title}</h2><button onclick="$('#modal').close()" aria-label="Close dialog">×</button></div>${html}`;
  if (!$("#modal").open) $("#modal").showModal();
}
function formModal(title, fields, fn, label = "Create") {
  modal(
    title,
    `<form id="modal-form">${fields}<div class="modalfooter"><button type="button" class="secondary" onclick="$('#modal').close()">Cancel</button><button class="primary">${label}</button></div></form>`,
  );
  $("#modal-form").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.submitter;
    b.disabled = true;
    try {
      await fn(new FormData(e.target));
      $("#modal").close();
      await refresh();
      render();
    } catch (err) {
      toast(err.message);
    } finally {
      b.disabled = false;
    }
  };
}
const field = (name, label, placeholder = "", area = false) =>
  `<label>${label}${area ? `<textarea name="${name}" placeholder="${placeholder}" required></textarea>` : `<input name="${name}" placeholder="${placeholder}" required>`}</label>`;
function newMatter() {
  formModal(
    "Create a matter",
    field("name", "Matter name", "Project Atlas") +
      field("client", "Client or organization", "Atlas Holdings") +
      field("description", "Description", "Commercial contract review"),
    async (f) => {
      const m = await api("matters", Object.fromEntries(f));
      matterId = m.id;
      view = "documents";
    },
  );
}
function newReview() {
  if (!docs().length) return toast("Upload documents first.");
  formModal(
    "Create a tabular review",
    field("name", "Review name", "Contract diligence") +
      field(
        "columns",
        "Questions — one per line",
        "Governing law\nLiability cap\nAssignment restrictions",
        true,
      ),
    async (f) => {
      const r = await api("reviews", {
        matterId,
        name: f.get("name"),
        columns: f
          .get("columns")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      activeReview = r.id;
      view = "review";
    },
    "Run review",
  );
}
function newDraft() {
  if (!docs().length) return toast("Upload documents first.");
  formModal(
    "Create a draft",
    field("title", "Title", "Review memorandum") +
      field(
        "prompt",
        "What should the draft cover?",
        "Summarize governing law and liability",
        true,
      ),
    async (f) => {
      const d = await api("drafts", { matterId, ...Object.fromEntries(f) });
      activeDraft = d.id;
      view = "editor";
    },
    "Create draft",
  );
}
function newSkill() {
  formModal(
    "Create a skill",
    field("name", "Skill name", "Your review process") +
      field(
        "instructions",
        "Instructions",
        "Describe your standards and approach",
        true,
      ),
    (f) => api("skills", Object.fromEntries(f)),
  );
}
function newTask() {
  if (!matterId) return toast("Create a matter first.");
  formModal(
    "Add a task",
    field("title", "Task", "What needs to happen?"),
    (f) => api("tasks", { matterId, title: f.get("title") }),
  );
}
async function updateTask(id, status) {
  try {
    await api("tasks/" + id, { status }, "PATCH");
    await refresh();
    render();
  } catch (e) {
    toast(e.message);
  }
}
function showDoc(id, paragraph) {
  const d = S.documents.find((d) => d.id === id);
  if (!d) return toast("Document unavailable.");
  modal(
    esc(d.name),
    `<div class="sourceviewer"><div class="source-meta">${d.sample ? "SAMPLE DOCUMENT · " : ""}SOURCE TEXT${d.supersededBy ? " · PREVIOUS VERSION" : ""}</div>${d.text
      .split(/\n\s*\n/)
      .map(
        (p, i) =>
          `<p class="${i + 1 === paragraph ? "highlight" : ""}"><span>¶ ${i + 1}</span>${esc(p)}</p>`,
      )
      .join("")}</div>`,
  );
  if (paragraph) $("#modal .highlight")?.scrollIntoView({ block: "center" });
}
function inspectCell(rid, cid) {
  const r = S.reviews.find((r) => r.id === rid),
    c = r.cells.find((c) => c.id === cid);
  modal(
    esc(r.columns[c.column]),
    `<div class="evidencepanel"><div class="source-meta">${esc(S.documents.find((d) => d.id === c.documentId)?.name)} · ${c.reviewed ? "REVIEWED" : "NEEDS REVIEW"}</div><label>Finding<textarea id="cellvalue" ${c.locked ? "disabled" : ""}>${esc(c.value)}</textarea></label><div class="cell-actions"><button class="secondary" onclick="changeCell('${rid}','${cid}',{reviewed:${!c.reviewed}})">${c.reviewed ? "Unmark reviewed" : "✓ Mark reviewed"}</button><button class="secondary" onclick="changeCell('${rid}','${cid}',{locked:${!c.locked}})">${c.locked ? "Unlock cell" : "Lock cell"}</button><button class="primary" ${c.locked ? "disabled" : ""} onclick="changeCell('${rid}','${cid}',{value:$('#cellvalue').value})">Save finding</button></div><h3>Source evidence</h3>${c.citations.map((e) => `<blockquote>${esc(e.text)}<button class="textbutton" onclick="showDoc('${e.documentId}',${e.paragraph})">Open paragraph ${e.paragraph} ↗</button></blockquote>`).join("") || "<p>No supporting passage found.</p>"}</div>`,
  );
}
async function changeCell(rid, cid, body) {
  try {
    await api(`reviews/${rid}/cells/${cid}`, body, "PATCH");
    await refresh();
    $("#modal").close();
    render();
    toast("Review updated");
  } catch (e) {
    toast(e.message);
  }
}
async function saveDraft(id) {
  try {
    await api("drafts/" + id, { title: $("#draft-title").value }, "PATCH");
    await refresh();
    toast("Title saved");
  } catch (e) {
    toast(e.message);
  }
}
async function deleteDoc(id) {
  modal(
    "Delete document?",
    `<p>This removes its source text. Existing findings remain, but their source will no longer open.</p><div class="modalfooter"><button class="secondary" onclick="$('#modal').close()">Cancel</button><button class="primary" id="confirm-delete">Delete document</button></div>`,
  );
  $("#confirm-delete").onclick = async () => {
    try {
      await api("documents/" + id, undefined, "DELETE");
      await refresh();
      $("#modal").close();
      render();
    } catch (e) {
      toast(e.message);
    }
  };
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportReview(id) {
  const r = S.reviews.find((r) => r.id === id),
    q = (s) =>
      '"' +
      (/^[=+@\-\t\r]/.test(String(s)) ? "'" : "") +
      String(s).replace(/"/g, '""') +
      '"';
  const rows = [
    ["Document", ...r.columns],
    ...[...new Set(r.cells.map((c) => c.documentId))].map((d) => [
      S.documents.find((x) => x.id === d)?.name || "Deleted document",
      ...r.columns.map(
        (_, i) =>
          r.cells.find((c) => c.documentId === d && c.column === i)?.value ||
          "",
      ),
    ]),
  ];
  download(
    "review.csv",
    rows.map((row) => row.map(q).join(",")).join("\r\n"),
    "text/csv",
  );
}
async function send(query, skillId) {
  if (busy || !query.trim()) return;
  if (!matterId) return toast("Create a matter first.");
  busy = true;
  render();
  try {
    await api("chat", { matterId, query, skillId });
    await refresh();
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
    render();
    $(".conversation")?.scrollTo(0, 999999);
  }
}
function uploadDocuments() {
  if (!matterId) return toast("Create a matter first.");
  $("#upload")?.click();
}
function bind() {
  if (["workflows", "intake", "monitors"].includes(view)) loadWorkflowViews();
  if (view === "integrations") loadConnectors();
  if (view === "editor" && $("#draft-content")) {
    const drafts = S.drafts.filter((d) => d.matterId === matterId),
      draft = drafts.find((d) => d.id === activeDraft) || drafts[0];
    if (draft)
      window.CounselCollab?.attach(
        draft.id,
        $("#draft-content"),
        $("#collaboration-status"),
      );
  }
  if ($("#matter-select"))
    $("#matter-select").onchange = (e) => {
      matterId = e.target.value;
      render();
    };
  if ($("#home-send"))
    $("#home-send").onclick = () => {
      const q = $("#home-query").value;
      view = "assistant";
      send(q || "Summarize governing law, liability and assignment");
    };
  if ($("#chat-form"))
    $("#chat-form").onsubmit = (e) => {
      e.preventDefault();
      send($("#query").value, $("#skill-select").value);
    };
  if ($("#query"))
    $("#query").onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        $("#chat-form").requestSubmit();
      }
    };
  if ($("#upload"))
    $("#upload").onchange = async (e) => {
      const f = new FormData();
      f.append("matterId", matterId);
      for (const file of e.target.files) f.append("files", file);
      try {
        toast("Reading documents…");
        const result = await api("documents", f);
        await refresh();
        render();
        toast(
          result
            .map((r) =>
              r.error ? `${r.name}: ${r.error}` : `Imported ${r.name}`,
            )
            .join(" · "),
        );
      } catch (e) {
        toast(e.message);
      }
    };
  if ($("#doc-search"))
    $("#doc-search").oninput = (e) =>
      ($("#document-list").innerHTML = documentList(
        docs().filter((d) =>
          d.name.toLowerCase().includes(e.target.value.toLowerCase()),
        ),
      ));
  if ($("#review-select"))
    $("#review-select").onchange = (e) => {
      activeReview = e.target.value;
      render();
    };
  if ($("#draft-select"))
    $("#draft-select").onchange = (e) => {
      activeDraft = e.target.value;
      render();
    };
}
loadSession()
  .then(async (signedIn) => {
    if (!signedIn) return authScreen();
    await refresh();
    render();
    resumeRun();
  })
  .catch(() => {
    $("#app").textContent = "Unable to load workspace. Reload to try again.";
  });
