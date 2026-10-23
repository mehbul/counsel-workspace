let workflowCache = {
    templates: [],
    runs: [],
    intake: [],
    monitors: [],
    alerts: [],
  },
  workflowPoll,
  workflowBuilder;
const runStatus = (s) =>
  `<span class="run-status ${esc(s)}">${esc(s.replaceAll("_", " "))}</span>`;
const editable = () => authState?.user?.role !== "viewer";
async function loadWorkflowViews() {
  clearTimeout(workflowPoll);
  const current = view,
    currentMatter = matterId;
  try {
    const [a, b] = await Promise.all([
      api("workflows", undefined, "GET"),
      api("operations", undefined, "GET"),
    ]);
    if (view !== current || matterId !== currentMatter) return;
    workflowCache = { ...a, ...b };
    const el = $("#workflow-content");
    if (!el) return;
    if (view === "workflows")
      el.innerHTML = `<div class="sectiontitle"><h2>Workflow library</h2><span class="muted">Saved steps · reviewed outputs</span></div><div class="workflow-grid">${a.templates.map((t) => `<article class="workflow-card"><span class="pill">Version ${t.version}</span><h2>${esc(t.name)}</h2><p>${esc(t.description)}</p><ol class="step-preview">${t.steps.map((s) => `<li>${esc(s.name)} <small>${esc(s.kind)}</small></li>`).join("")}</ol><footer><button class="textbutton" onclick="editWorkflow('${t.id}')">${editable() ? "Edit template" : "View template"}</button>${editable() ? `<button class="primary" onclick="startWorkflow('${t.id}')">Start workflow ↗</button>` : ""}</footer></article>`).join("")}</div><div class="sectiontitle"><h2>Run history</h2><span class="muted">Current matter</span></div><div class="recentlist">${
        a.runs
          .filter((r) => r.matterId === matterId)
          .map(
            (r) =>
              `<button class="run-row" onclick="inspectWorkflowRun('${r.id}')"><div><strong>${esc(r.name)}</strong><small>Template v${r.templateVersion} · ${r.stepIndex}/${r.steps.length} steps · ${new Date(r.created).toLocaleString()}</small></div>${runStatus(r.status)}<span>Open →</span></button>`,
          )
          .join("") || '<p class="muted">No runs for this matter yet.</p>'
      }</div>`;
    if (view === "intake")
      el.innerHTML = `<div class="operations-note">Track requests, assign a lawyer, run a workflow, and record the approved resolution. Requests created here stay inside this workspace.</div><div class="recentlist">${
        b.intake
          .filter((x) => x.matterId === matterId)
          .sort((a, b) => b.created.localeCompare(a.created))
          .map(
            (x) =>
              `<button class="run-row" onclick="inspectIntake('${x.id}')"><div><strong>${esc(x.title)}</strong><small>${esc(x.priority)} priority · ${esc(x.assignee || "Unassigned")} · ${esc(x.requester)}</small></div>${runStatus(x.status)}</button>`,
          )
          .join("") || '<p class="muted">No requests for this matter.</p>'
      }</div>`;
    if (view === "monitors")
      el.innerHTML = `<div class="operations-note">Watch newly imported matter documents for matching evidence. These monitors do not fetch legislation or legal news. Select Scan after an import.</div><div class="workflow-grid">${
        b.monitors
          .filter((x) => x.matterId === matterId)
          .map(
            (x) =>
              `<article class="workflow-card"><h2>${esc(x.name)}</h2><p>${esc(x.query)}</p><small>${x.lastScan ? "Last scanned " + new Date(x.lastScan).toLocaleString() : "Baseline saved at creation"}</small>${editable() ? `<button class="secondary" onclick="scanMonitor('${x.id}')">Scan new documents</button>` : ""}</article>`,
          )
          .join("") || '<p class="muted">Create a monitor to track a topic.</p>'
      }</div><div class="sectiontitle"><h2>Evidence alerts</h2></div><div class="recentlist">${
        b.alerts
          .filter((x) => x.matterId === matterId)
          .map(
            (x) =>
              `<article class="draft-comment"><strong>${esc(x.name)} · ${esc(x.documentName)}</strong> ${runStatus(x.status)}<p>${esc(x.citations[0]?.text)}</p><div class="rich-actions"><button class="secondary" onclick="showDoc('${x.documentId}',${x.citations[0]?.paragraph || 1})">Open evidence</button>${editable() && x.status === "new" ? `<button class="primary" onclick="decideMonitorAlert('${x.id}','task')">Create follow-up task</button><button class="secondary" onclick="decideMonitorAlert('${x.id}','dismiss')">Dismiss</button>` : ""}</div></article>`,
          )
          .join("") || '<p class="muted">No matching new documents yet.</p>'
      }</div>`;
    if (
      view === "workflows" &&
      a.runs.some(
        (r) =>
          r.matterId === matterId && ["queued", "running"].includes(r.status),
      )
    )
      workflowPoll = setTimeout(loadWorkflowViews, 1500);
  } catch (e) {
    if ($("#workflow-content")) $("#workflow-content").textContent = e.message;
  }
}
function editWorkflow(id) {
  const found = workflowCache.templates.find((t) => t.id === id);
  workflowBuilder = found
    ? structuredClone(found)
    : {
        name: "",
        description: "",
        steps: [
          {
            kind: "search",
            name: "Find supporting evidence",
            prompt: "{{input}}",
          },
          { kind: "approval", name: "Review findings" },
        ],
      };
  drawWorkflowBuilder();
}
function captureWorkflowBuilder() {
  const f = $("#workflow-builder");
  if (!f) return;
  workflowBuilder.name = f.elements.name.value;
  workflowBuilder.description = f.elements.description.value;
  for (const [i, s] of workflowBuilder.steps.entries()) {
    s.kind = f.elements["kind-" + i].value;
    s.name = f.elements["step-" + i].value;
    const p = f.elements["prompt-" + i];
    if (p) s.prompt = p.value;
    const cols = f.elements["columns-" + i];
    if (cols)
      s.columns = cols.value
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    const sk = f.elements["skill-" + i];
    if (sk?.value) s.skillId = sk.value;
    else delete s.skillId;
  }
}
function drawWorkflowBuilder() {
  modal(
    workflowBuilder.id ? "Workflow template" : "Create a workflow",
    `<form id="workflow-builder"><div class="form-grid"><label>Name<input name="name" value="${esc(workflowBuilder.name)}" required maxlength="200"></label><label>Description<input name="description" value="${esc(workflowBuilder.description)}" maxlength="2000"></label></div><p>Build an ordered process. Approval steps pause until a lawyer approves or rejects the work. Use {{input}} for the request and {{previous}} for the preceding output.</p><div class="builder-steps">${workflowBuilder.steps.map((s, i) => `<section class="builder-step"><div class="step-heading"><strong>Step ${i + 1}</strong><button class="textbutton" type="button" onclick="moveWorkflowStep(${i},-1)" ${i === 0 ? "disabled" : ""}>Move up</button><button class="textbutton" type="button" onclick="moveWorkflowStep(${i},1)" ${i === workflowBuilder.steps.length - 1 ? "disabled" : ""}>Move down</button><button class="textbutton" type="button" onclick="removeWorkflowStep(${i})">Remove</button></div><label>Step name<input name="step-${i}" value="${esc(s.name)}" required maxlength="200"></label><label>Action<select name="kind-${i}" onchange="changeWorkflowKind(${i})">${["search", "review", "approval", "draft", "task"].map((k) => `<option value="${k}" ${k === s.kind ? "selected" : ""}>${{ search: "Find evidence", review: "Tabular review", approval: "Human approval", draft: "Create draft", task: "Create task" }[k]}</option>`).join("")}</select></label>${s.kind === "review" ? `<label>Questions — one per line<textarea name="columns-${i}" required>${esc((s.columns || ["Governing law"]).join("\n"))}</textarea></label>` : s.kind !== "approval" ? `<label>Instructions<textarea name="prompt-${i}" maxlength="20000" required>${esc(s.prompt || "{{input}}")}</textarea></label>` : ""}${["search", "draft"].includes(s.kind) ? `<label>Apply a skill<select name="skill-${i}"><option value="">No skill</option>${S.skills.map((sk) => `<option value="${sk.id}" ${sk.id === s.skillId ? "selected" : ""}>${esc(sk.name)} · v${sk.version || 1}</option>`).join("")}</select></label>` : ""}</section>`).join("")}</div>${editable() ? '<button class="secondary" type="button" onclick="addWorkflowStep()">＋ Add step</button><div class="modalfooter"><button class="primary">Save workflow</button></div>' : ""}</form>`,
  );
  $("#workflow-builder").onsubmit = async (e) => {
    e.preventDefault();
    captureWorkflowBuilder();
    const { id, version, ...body } = workflowBuilder;
    body.steps = body.steps.map((s) => {
      const value = { kind: s.kind, name: s.name };
      if (s.kind === "review") value.columns = s.columns || ["Governing law"];
      else if (s.kind !== "approval") value.prompt = s.prompt || "{{input}}";
      if (["search", "draft"].includes(s.kind) && s.skillId)
        value.skillId = s.skillId;
      return value;
    });
    try {
      await api(
        "workflows" + (id ? "/" + id : ""),
        id ? { ...body, version } : body,
        id ? "PATCH" : "POST",
      );
      $("#modal").close();
      await loadWorkflowViews();
      toast("Workflow saved");
    } catch (e) {
      toast(e.message);
    }
  };
}
function addWorkflowStep() {
  captureWorkflowBuilder();
  if (workflowBuilder.steps.length >= 12) return toast("Use up to 12 steps.");
  workflowBuilder.steps.push({
    kind: "task",
    name: "Follow up",
    prompt: "{{input}}",
  });
  drawWorkflowBuilder();
}
function removeWorkflowStep(i) {
  captureWorkflowBuilder();
  if (workflowBuilder.steps.length === 1)
    return toast("Keep at least one step.");
  workflowBuilder.steps.splice(i, 1);
  drawWorkflowBuilder();
}
function moveWorkflowStep(i, d) {
  captureWorkflowBuilder();
  const a = workflowBuilder.steps;
  [a[i], a[i + d]] = [a[i + d], a[i]];
  drawWorkflowBuilder();
}
function changeWorkflowKind(i) {
  captureWorkflowBuilder();
  drawWorkflowBuilder();
}
function startWorkflow(id) {
  const t = workflowCache.templates.find((t) => t.id === id);
  if (!t) return;
  formModal(
    "Start " + esc(t.name),
    `<p>Run in <strong>${esc(matter()?.name)}</strong>. The selected source versions and workflow instructions are saved for this run.</p>${field("input", "Instructions for this run", "What should the team focus on?", true)}<fieldset class="source-checks"><legend>Source documents</legend>${
      docs()
        .map(
          (d) =>
            `<label><input type="checkbox" name="documentIds" value="${d.id}" checked>${esc(d.name)}</label>`,
        )
        .join("") ||
      "<p>No documents. Evidence steps will report missing evidence.</p>"
    }</fieldset>`,
    async (f) => {
      const ids = f.getAll("documentIds");
      if (docs().length && !ids.length)
        throw Error("Select at least one source document.");
      await api(`workflows/${id}/runs`, {
        matterId,
        input: f.get("input"),
        documentIds: ids,
      });
      view = "workflows";
    },
    "Start run",
  );
}
async function inspectWorkflowRun(id) {
  try {
    const run = await api("workflow-runs/" + id, undefined, "GET");
    modal(
      esc(run.name),
      `<div class="run-detail-heading">${runStatus(run.status)}<small>Template v${run.templateVersion} · ${run.documentIds.length} source documents</small><button class="secondary" onclick="inspectWorkflowRun('${id}')">Refresh status</button></div>${run.error ? `<p class="autherror">${esc(run.error)}</p>` : ""}<p>${esc(run.input)}</p><ol class="run-timeline">${run.steps
        .map((s, i) => {
          const out = run.outputs.find(
              (o) => o.step === i && o.kind !== "approval",
            ),
            approval = run.outputs.find(
              (o) => o.step === i && o.kind === "approval",
            );
          return `<li class="${i < run.stepIndex ? "complete" : i === run.stepIndex ? "current" : ""}"><strong>${esc(s.name)}</strong><small>${esc(s.kind)}${i < run.stepIndex ? " · Complete" : ""}</small>${out ? `<button class="textbutton" onclick="openWorkflowArtifact('${id}',${i})">Open ${esc(out.kind)} →</button>` : ""}${approval ? `<p>${esc(approval.decision)} by ${esc(approval.actor)}: ${esc(approval.note)}</p>` : ""}</li>`;
        })
        .join(
          "",
        )}</ol>${editable() ? `<div class="rich-actions">${run.status === "waiting_approval" ? `<label>Review note<textarea id="approval-note" maxlength="5000"></textarea></label><button class="primary" onclick="decideWorkflow('${id}',${run.revision},'approve')">Approve and continue</button><button class="secondary" onclick="decideWorkflow('${id}',${run.revision},'reject')">Reject</button>` : ""}${run.status === "failed" ? `<button class="primary" onclick="decideWorkflow('${id}',${run.revision},'retry')">Retry failed step</button>` : ""}${!["completed", "cancelled"].includes(run.status) ? `<button class="secondary" onclick="decideWorkflow('${id}',${run.revision},'cancel')">Cancel run</button>` : ""}</div>` : ""}`,
    );
  } catch (e) {
    toast(e.message);
  }
}
async function decideWorkflow(id, revision, action) {
  try {
    await api(`workflow-runs/${id}/decision`, {
      revision,
      action,
      note: $("#approval-note")?.value || "",
    });
    await loadWorkflowViews();
    await inspectWorkflowRun(id);
  } catch (e) {
    toast(e.message);
  }
}
async function openWorkflowArtifact(id, index) {
  try {
    const r = await api("workflow-runs/" + id, undefined, "GET"),
      o = r.outputs.find((x) => x.step === index && x.kind !== "approval");
    if (!o) return;
    await refresh();
    $("#modal").close();
    matterId = r.matterId;
    if (o.kind === "draft") {
      activeDraft = o.artifactId;
      go("editor");
    } else if (o.kind === "review") {
      activeReview = o.artifactId;
      go("review");
    } else go(o.kind === "task" ? "tasks" : "assistant");
  } catch (e) {
    toast(e.message);
  }
}
function newIntake() {
  formModal(
    "New legal request",
    field("title", "Request title", "Review a supplier agreement") +
      field(
        "description",
        "What do you need?",
        "Describe the question, context and expected output",
        true,
      ) +
      '<label>Priority<select name="priority"><option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>',
    (f) => api("intake", { matterId, ...Object.fromEntries(f) }),
  );
}
async function inspectIntake(id) {
  const op = workflowCache.intake.find((x) => x.id === id);
  if (!op) return;
  try {
    const members = await api(
      "matter-members?matterId=" + matterId,
      undefined,
      "GET",
    );
    const transitions = {
      new: ["triaged", "rejected"],
      triaged: ["in_progress", "rejected"],
      in_progress: ["awaiting_approval", "rejected"],
      awaiting_approval: ["in_progress", "completed", "rejected"],
      completed: [],
      rejected: [],
    };
    modal(
      esc(op.title),
      `<p>${esc(op.description)}</p><p>${runStatus(op.status)} · ${esc(op.priority)} priority · ${esc(op.requester)}</p>${op.runId ? `<button class="secondary" onclick="inspectWorkflowRun('${op.runId}')">View linked workflow</button>` : ""}${editable() && !["completed", "rejected"].includes(op.status) ? `<form id="intake-update"><label>Responsible lawyer<select name="assigneeId"><option value="">Keep current assignment</option>${members.map((m) => `<option value="${m.id}" ${m.id === op.assigneeId ? "selected" : ""}>${esc(m.email)}</option>`).join("")}</select></label><label>Next status<select name="status"><option value="">Keep current status</option>${transitions[op.status].map((s) => `<option value="${s}">${esc(s.replaceAll("_", " "))}</option>`).join("")}</select></label>${!op.runId && ["new", "triaged"].includes(op.status) ? `<label>Start a workflow<select name="workflowId"><option value="">No workflow</option>${workflowCache.templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>` : ""}<label>Resolution / approval note<textarea name="resolution" maxlength="10000">${esc(op.resolution || "")}</textarea></label><button class="primary">Update request</button></form>` : `<p>${esc(op.resolution || "")}</p>`}`,
    );
    if ($("#intake-update"))
      $("#intake-update").onsubmit = async (e) => {
        e.preventDefault();
        const b = { revision: op.revision };
        for (const [k, v] of new FormData(e.target)) if (v) b[k] = v;
        try {
          await api("intake/" + id, b, "PATCH");
          $("#modal").close();
          await loadWorkflowViews();
          toast("Request updated");
        } catch (e) {
          toast(e.message);
        }
      };
  } catch (e) {
    toast(e.message);
  }
}
function newMonitor() {
  formModal(
    "Monitor matter documents",
    field("name", "Monitor name", "Assignment restrictions") +
      field("query", "Terms to watch", "assignment consent") +
      "<p>Current document versions form the baseline. Scan after importing new documents to create evidence alerts.</p>",
    (f) => api("monitors", { matterId, ...Object.fromEntries(f) }),
  );
}
async function scanMonitor(id) {
  try {
    const r = await api(`monitors/${id}/scan`, {});
    await loadWorkflowViews();
    toast(r.created + " new evidence alerts");
  } catch (e) {
    toast(e.message);
  }
}
async function decideMonitorAlert(id, action) {
  try {
    await api("monitor-alerts/" + id, { action }, "PATCH");
    await refresh();
    await loadWorkflowViews();
    toast(action === "task" ? "Follow-up added to Lists" : "Alert dismissed");
  } catch (e) {
    toast(e.message);
  }
}
function editSkill(id) {
  const s = S.skills.find((x) => x.id === id);
  formModal(
    "Edit skill",
    `<label>Name<input name="name" value="${esc(s.name)}" required maxlength="200"></label><label>Category<input name="category" value="${esc(s.category)}" maxlength="100"></label><label>Instructions<textarea name="instructions" required maxlength="20000">${esc(s.instructions)}</textarea></label><p>Saving creates a new version. Existing workflow runs retain their original instructions.</p>`,
    (f) =>
      api(
        "skills/" + id,
        { ...Object.fromEntries(f), version: s.version || 1 },
        "PATCH",
      ),
    "Save version",
  );
}
async function skillHistory(id) {
  try {
    const versions = await api(`skills/${id}/versions`, undefined, "GET");
    modal(
      "Skill versions",
      versions
        .map(
          (s) =>
            `<details class="draft-comment"><summary>Version ${s.version} · ${esc(s.name)}</summary><p>${esc(s.instructions)}</p></details>`,
        )
        .join("") ||
        "<p>No saved revisions yet. The current skill is version 1.</p>",
    );
  } catch (e) {
    toast(e.message);
  }
}
