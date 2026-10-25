async function assistantConnections() {
  try {
    const keys = await api("agent-tokens", undefined, "GET");
    modal(
      "Connect Codex, Claude or another assistant",
      `<p>Your assistant can use Counsel through MCP. The bridge makes no model API calls; your assistant's normal subscription, limits and data policy apply.</p><p>A connection can read selected matter documents. A write key can also import text and create unreviewed drafts, evidence tables and tasks. Revoking the key stops future calls.</p><div class="recentlist">${keys.map((k) => `<article class="draft-comment"><strong>${esc(k.name)}</strong><small>${esc(k.mode)} access · ${k.matterIds.length} matters · expires ${new Date(k.expires).toLocaleDateString()} ${k.revoked ? "· Revoked" : k.expires < Date.now() ? "· Expired" : ""}</small>${!k.revoked && k.expires > Date.now() ? `<button class="secondary" onclick="revokeAssistantKey('${k.id}')">Revoke connection</button>` : ""}</article>`).join("") || "<p>No assistant connections yet.</p>"}</div><form id="assistant-key-form"><label>Connection name<input name="name" required maxlength="100" placeholder="My Codex workspace"></label><label>Access<select name="mode"><option value="read">Read only</option><option value="write">Read and create work</option></select></label><label>Expiry<select name="expiresInDays"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></label><fieldset class="source-checks"><legend>Allow these matters</legend>${S.matters.map((m) => `<label><input type="checkbox" name="matterIds" value="${m.id}" ${m.id === matterId ? "checked" : ""}>${esc(m.name)}</label>`).join("")}</fieldset><p>When a connected assistant reads a document, that content enters the assistant provider's context. Select only matters you are authorized to share with that provider.</p><button class="primary">Create connection key</button></form>`,
    );
    $("#assistant-key-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const data = await api("agent-tokens", {
          name: f.get("name"),
          mode: f.get("mode"),
          expiresInDays: Number(f.get("expiresInDays")),
          matterIds: f.getAll("matterIds"),
        });
        modal(
          "Connection ready",
          `<p>This key is shown only through this download step. Keep the file private; it grants ${esc(data.mode)} access until ${new Date(data.expires).toLocaleDateString()} or revocation.</p><button class="primary" id="download-assistant-connection">Download connection file</button><p>Run the included MCP adapter from your computer and point Codex, Claude Code or another local MCP client to it:</p><pre><code>node /absolute/path/to/counsel/mcp/server.mjs\n  --connection-file /absolute/path/to/counsel-connection.json</code></pre><p>Client setup examples are in docs/ASSISTANTS.md in the repository. No OpenAI or Anthropic API key is needed for this host-powered path.</p><button class="secondary" onclick="assistantConnections()">Manage connections</button>`,
        );
        $("#download-assistant-connection").onclick = () =>
          download(
            "counsel-connection.json",
            JSON.stringify(
              { url: location.origin, token: data.token },
              null,
              2,
            ),
            "application/json",
          );
      } catch (e) {
        toast(e.message);
      }
    };
  } catch (e) {
    toast(e.message);
  }
}
async function revokeAssistantKey(id) {
  try {
    await api("agent-tokens/" + id, undefined, "DELETE");
    await assistantConnections();
    toast("Assistant connection revoked");
  } catch (e) {
    toast(e.message);
  }
}
