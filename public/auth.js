let authState = null;
async function loadSession() {
  authState = await (await fetch("/api/auth/me")).json();
  if (authState.user) {
    const guest = authState.user.role === "guest";
    if (guest && location.pathname !== "/portal.html") {
      location.replace("/portal.html");
      return false;
    }
    if (!guest && location.pathname === "/portal.html") {
      location.replace("/");
      return false;
    }
  }
  return !!authState.user;
}
function authScreen(error = "") {
  const setup = authState?.setupRequired;
  document.querySelector("#app").innerHTML =
    `<div class="authscreen"><div class="authcard"><a class="brand"><span class="brandmark">c</span>counsel</a><div class="eyebrow">YOUR LEGAL WORKSPACE</div><h1>${setup ? "Set up your workspace." : "Welcome back."}</h1><p>${setup ? "Create your owner account. The setup token is in the persistent data folder, in bootstrap-token." : "Sign in to your secure workspace."}</p><form id="auth-form">${setup ? '<label>Setup token<input name="token" type="password" required autocomplete="off"></label><label>Workspace name<input name="workspace" required maxlength="100"></label>' : ""}<label>Email<input type="email" name="email" required autocomplete="username"></label><label>Password<input type="password" name="password" required ${setup ? 'minlength="14"' : ""} maxlength="256" autocomplete="${setup ? "new-password" : "current-password"}"></label><p class="autherror" role="alert">${esc(error)}</p><button class="primary">${setup ? "Create workspace" : "Sign in"}</button></form><small>${setup ? "Choose a password of at least 14 characters. Existing local documents are transferred to this owner workspace." : "Your organization controls access to this workspace."}</small></div></div>`;
  document.querySelector("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    e.submitter.disabled = true;
    try {
      const r = await fetch("/api/auth/" + (setup ? "setup" : "login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error || "Unable to sign in");
      if (!(await loadSession())) return;
      await refresh();
      view = "home";
      render();
    } catch (e) {
      authScreen(e.message);
    }
  };
}
async function logout() {
  try {
    await api("auth/logout", {});
    authState = null;
    await loadSession();
    authScreen();
  } catch (e) {
    toast(e.message);
  }
}
function account() {
  if (authState.personal)
    return modal(
      "Personal workspace",
      '<p>This workspace opens directly on your computer. Access is limited to direct local browser connections.</p><button class="secondary" onclick="assistantConnections()">Connect an assistant</button> <button class="secondary" onclick="openModelSettings()">Model settings</button> <button class="secondary" onclick="auditLog()">View audit log</button>',
    );
  modal(
    "Your account",
    `<p>${esc(authState.user.email)} · ${esc(authState.user.role)}</p><button class="secondary" onclick="changePassword()">Change password</button> ${["owner", "editor"].includes(authState.user.role) ? '<button class="secondary" onclick="assistantConnections()">Connect an assistant</button>' : ""} ${authState.user.role === "owner" ? '<button class="secondary" onclick="openModelSettings()">Model settings</button> <button class="secondary" onclick="manageMembers()">Manage members</button> <button class="secondary" onclick="auditLog()">Audit log</button> <button class="secondary" onclick="matterAccess()">Matter access</button>' : ""}<button class="primary" onclick="$('#modal').close();logout()">Sign out</button>`,
  );
}
function changePassword() {
  formModal(
    "Change password",
    field("currentPassword", "Current password") +
      field("password", "New password — at least 14 characters"),
    async (f) => {
      const result = await api("auth/password", Object.fromEntries(f));
      authState.csrf = result.csrf;
      toast("Password changed. Other sessions were signed out.");
    },
    "Change password",
  );
  document
    .querySelectorAll("#modal input")
    .forEach((i) => (i.type = "password"));
}
async function manageMembers() {
  try {
    const users = await (await fetch("/api/admin/users")).json();
    modal(
      "Workspace members",
      `<p>Owners manage accounts. Editors can change workspace content; viewers can read and export. Client guests can read only explicitly published items for their assigned matters.</p><div class="recentlist">${users.map((u) => `<div class="activityrow"><strong>${esc(u.email)}</strong><span>${esc(u.role)} ${u.disabled ? "· Disabled" : ""}</span>${u.role !== "owner" ? `<button class="secondary" onclick="toggleMember('${u.id}',${!u.disabled})">${u.disabled ? "Enable" : "Disable"}</button>` : ""}</div>`).join("")}</div><div class="modalfooter"><button class="primary" onclick="createMember()">Add member</button></div>`,
    );
  } catch (e) {
    toast(e.message);
  }
}
function createMember() {
  formModal(
    "Add a workspace member",
    field("email", "Email") +
      field("password", "Temporary password — at least 14 characters") +
      '<label>Role<select name="role"><option value="editor">Editor</option><option value="viewer">Viewer</option><option value="guest">Client guest — portal only</option></select></label>',
    (f) => api("admin/users", Object.fromEntries(f)),
    "Create account",
  );
  $("#modal input[name=password]").type = "password";
  $("#modal input[name=email]").type = "email";
}
async function toggleMember(id, disabled) {
  try {
    await api("admin/users/" + id, { disabled }, "PATCH");
    manageMembers();
  } catch (e) {
    toast(e.message);
  }
}
async function auditLog() {
  try {
    const rows = await (await fetch("/api/admin/audit")).json();
    modal(
      "Workspace audit log",
      `<p>Latest 500 persisted events. Workspace users cannot modify or delete these records through the application.</p><div class="recentlist">${rows.map((a) => `<div class="activityrow"><strong>${esc(a.action)}</strong><small>${esc(a.resource)} · ${esc(a.created)}</small></div>`).join("")}</div>`,
    );
  } catch (e) {
    toast(e.message);
  }
}

async function matterAccess() {
  try {
    const users = await (await fetch("/api/admin/users")).json(),
      grants = await (await fetch("/api/admin/access")).json();
    modal(
      "Matter access",
      `<p>Owners can access all matters. Other members see only explicitly assigned matters, including document search, drafts and exports.</p><div class="recentlist">${
        users
          .filter((u) => u.role !== "owner")
          .map(
            (u) =>
              `<div class="accessmember"><strong>${esc(u.email)}</strong>${S.matters.map((m) => `<label><input type="checkbox" ${grants.some((g) => g.user_id === u.id && g.matter_id === m.id) ? "checked" : ""} onchange="grantAccess('${u.id}','${m.id}',this)"> ${esc(m.name)}</label>`).join("")}</div>`,
          )
          .join("") || "<p>Add a member first.</p>"
      }</div>`,
    );
  } catch (e) {
    toast(e.message);
  }
}
async function grantAccess(userId, matterId, checkbox) {
  try {
    await api("admin/access", { userId, matterId, allowed: checkbox.checked });
    toast("Access updated");
  } catch (e) {
    checkbox.checked = !checkbox.checked;
    toast(e.message);
  }
}

async function resumeRun() {
  const saved = sessionStorage.getItem("pendingRun");
  if (!saved) return;
  let pending;
  try {
    pending = JSON.parse(saved);
  } catch {
    sessionStorage.removeItem("pendingRun");
    return;
  }
  try {
    const response = await fetch(
      "/api/jobs/" + encodeURIComponent(pending.jobId),
    );
    if (!response.ok) {
      sessionStorage.removeItem("pendingRun");
      return;
    }
    const job = await response.json();
    if (job.status === "failed") {
      sessionStorage.removeItem("pendingRun");
      return toast(job.error);
    }
    if (job.status === "completed") {
      sessionStorage.removeItem("pendingRun");
      await refresh();
      if (pending.url.includes("connectors")) {
        view = "integrations";
      } else if (pending.url === "reviews") {
        activeReview = job.result.id;
        matterId = job.result.matterId;
        view = "review";
      } else {
        activeDraft = job.result.id;
        matterId = job.result.matterId;
        view = "editor";
      }
      render();
      toast("Your background run is ready.");
    } else {
      toast("Your saved run is still processing.");
      setTimeout(resumeRun, 2000);
    }
  } catch {
    setTimeout(resumeRun, 5000);
  }
}
