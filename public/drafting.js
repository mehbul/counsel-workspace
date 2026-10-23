async function draftComments(id) {
  try {
    const response = await fetch(`/api/drafts/${id}/comments`);
    if (!response.ok) throw Error("Unable to load comments");
    const comments = await response.json();
    modal(
      "Draft comments",
      `<p>Comments apply to the whole draft. Select Refresh to see recent comments.</p><button class="secondary" onclick="draftComments('${id}')">Refresh</button><div class="recentlist">${comments.map((c) => `<article class="draft-comment"><small>${esc(c.author)} · ${new Date(c.created).toLocaleString()} ${c.resolved ? "· Resolved" : ""}</small><p>${esc(c.body)}</p><button class="textbutton" onclick="resolveDraftComment('${id}','${c.id}',${!c.resolved})">${c.resolved ? "Reopen" : "Resolve"}</button></article>`).join("") || "<p>No comments yet.</p>"}</div><form id="comment-form"><label>Add a comment<textarea name="body" required maxlength="5000"></textarea></label><button class="primary">Post comment</button></form>`,
    );
    $("#comment-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`drafts/${id}/comments`, {
          body: new FormData(e.target).get("body"),
        });
        draftComments(id);
      } catch (e) {
        toast(e.message);
      }
    };
  } catch (e) {
    toast(e.message);
  }
}
async function resolveDraftComment(id, commentId, resolved) {
  try {
    await api(`drafts/${id}/comments/${commentId}`, { resolved }, "PATCH");
    draftComments(id);
  } catch (e) {
    toast(e.message);
  }
}
async function draftHistory(id) {
  try {
    const response = await fetch(`/api/drafts/${id}/checkpoints`);
    if (!response.ok) throw Error("Unable to load history");
    const rows = await response.json();
    modal(
      "Draft checkpoints",
      `<p>Wait for All changes saved before creating a checkpoint. Restoring replaces the shared draft for everyone and saves a recovery checkpoint first.</p><form id="checkpoint-form"><label>Checkpoint name<input name="name" required maxlength="200" placeholder="e.g. Before partner review"></label><button class="primary">Save checkpoint</button></form><div class="recentlist">${rows.map((r) => `<article class="draft-comment"><strong>${esc(r.name)}</strong><small>${esc(r.author)} · ${new Date(r.created).toLocaleString()}</small><button class="secondary" onclick="restoreCheckpoint('${id}','${r.id}')">Restore this checkpoint</button></article>`).join("") || "<p>No checkpoints yet.</p>"}</div>`,
    );
    $("#checkpoint-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`drafts/${id}/checkpoints`, {
          name: new FormData(e.target).get("name"),
        });
        draftHistory(id);
      } catch (e) {
        toast(e.message);
      }
    };
  } catch (e) {
    toast(e.message);
  }
}
function restoreCheckpoint(id, checkpointId) {
  modal(
    "Restore this shared draft?",
    `<p>Everyone editing this draft will see the restored content. A Before restore checkpoint preserves the current draft.</p><div class="modalfooter"><button class="secondary" onclick="draftHistory('${id}')">Cancel</button><button class="primary" id="restore-checkpoint">Restore shared draft</button></div>`,
  );
  $("#restore-checkpoint").onclick = async () => {
    try {
      await api(`drafts/${id}/restore`, { checkpointId });
      $("#modal").close();
      await refresh();
      toast("Shared draft restored");
    } catch (e) {
      toast(e.message);
    }
  };
}
async function draftSuggestions(id) {
  try {
    const items = await api(`drafts/${id}/suggestions`, undefined, "GET");
    modal(
      "Proposed edits",
      `<p>Changes stay separate until accepted. Acceptance requires the exact original quote to appear once in the current draft; conflicting edits must be proposed again.</p><div class="recentlist">${items.map((s) => `<article class="draft-comment"><small>${esc(s.author)} · ${esc(s.status)}${s.reviewer ? " · " + esc(s.reviewer) : ""}</small><p><del>${esc(s.find)}</del></p><p><ins>${esc(s.replacement || "(delete quoted text)")}</ins></p><p>${esc(s.reason)}</p>${editable() && s.status === "pending" ? `<div class="rich-actions"><button class="primary" onclick="decideDraftSuggestion('${id}','${s.id}','accept')">Accept edit</button><button class="secondary" onclick="decideDraftSuggestion('${id}','${s.id}','reject')">Reject edit</button></div>` : ""}</article>`).join("") || "<p>No proposed edits yet.</p>"}</div>${editable() ? `<form id="suggestion-form"><label>Exact original quote<textarea name="find" required maxlength="100000"></textarea></label><label>Proposed replacement<textarea name="replacement" maxlength="100000"></textarea></label><label>Reason<input name="reason" maxlength="5000"></label><button class="primary">Propose edit</button></form>` : ""}`,
    );
    if ($("#suggestion-form"))
      $("#suggestion-form").onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api(
            `drafts/${id}/suggestions`,
            Object.fromEntries(new FormData(e.target)),
          );
          await draftSuggestions(id);
        } catch (e) {
          toast(e.message);
        }
      };
  } catch (e) {
    toast(e.message);
  }
}
async function decideDraftSuggestion(id, suggestionId, decision) {
  try {
    await api(
      `drafts/${id}/suggestions/${suggestionId}`,
      { decision },
      "PATCH",
    );
    await refresh();
    await draftSuggestions(id);
  } catch (e) {
    toast(e.message);
  }
}
