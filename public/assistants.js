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
        await assistantSetupWizard(data);
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

async function assistantSetupWizard(data) {
  const setup = await api("assistant-setup", undefined, "GET");
  modal(
    "Set up your assistant",
    `
    <p>1. Choose your client and transport. 2. Download your private connection file and client settings. 3. Test the connection.</p>
    <label>Assistant client<select id="assistant-client"><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="desktop">Claude Desktop / generic JSON client</option></select></label>
    <label>Transport<select id="assistant-transport"><option value="stdio">Local adapter (stdio)</option><option value="http">Direct Streamable HTTP (bearer-capable clients)</option></select></label>
    <label>Adapter path<input id="assistant-adapter" value="${esc(setup.adapterPath)}"></label>
    <label>Private connection file absolute path<input id="assistant-file" placeholder="C:/private/counsel-connection.json"></label>
    <p>The adapter path is on this server. If your assistant runs on another computer, use its local repository path. Keep credential files outside shared folders and Git. No client settings are overwritten.</p>
    <p>HTTP requires a client supporting custom bearer headers. OAuth and ordinary chatbot web connections are not supported. Remote workspace access requires HTTPS.</p>
    <button class="secondary" id="assistant-download-key">Download private connection file</button>
    <button class="primary" id="assistant-config">Generate client settings</button>
    <pre id="assistant-preview" style="white-space:pre-wrap"></pre>
    <button class="secondary" id="assistant-diagnose">Test key and workspace</button><p id="assistant-diagnostic" role="status"></p>
    <button class="secondary" onclick="assistantConnections()">Done / manage connections</button>`,
  );
  $("#assistant-download-key").onclick = () =>
    download(
      "counsel-connection.json",
      JSON.stringify({ url: location.origin, token: data.token }, null, 2),
      "application/json",
    );
  $("#assistant-config").onclick = () => {
    try {
      const client = $("#assistant-client").value,
        http = $("#assistant-transport").value === "http";
      const adapter = $("#assistant-adapter")
          .value.trim()
          .replaceAll("\\", "/"),
        file = $("#assistant-file").value.trim().replaceAll("\\", "/");
      if (
        !http &&
        (!/^(?:[a-z]:\/|\/)/i.test(file) || !/^(?:[a-z]:\/|\/)/i.test(adapter))
      )
        throw Error(
          "Enter absolute adapter and private connection file paths first.",
        );
      const url = location.origin + setup.httpPath;
      let content, filename;
      if (client === "codex") {
        content = http
          ? `[mcp_servers.counsel]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "COUNSEL_ASSISTANT_TOKEN"\n`
          : `[mcp_servers.counsel]\ncommand = "node"\nargs = ${JSON.stringify([adapter, "--connection-file", file])}\n`;
        filename = "counsel-codex.toml";
      } else {
        const entry = http
          ? {
              type: "http",
              url,
              headers: { Authorization: "Bearer " + data.token },
            }
          : { command: "node", args: [adapter, "--connection-file", file] };
        content = JSON.stringify({ mcpServers: { counsel: entry } }, null, 2);
        filename =
          client === "claude-code"
            ? "counsel-claude-code.mcp.json"
            : "counsel-desktop.json";
      }
      $("#assistant-preview").textContent =
        content +
        (http && client === "codex"
          ? "\nSet COUNSEL_ASSISTANT_TOKEN privately in the environment used to launch Codex to the token from your downloaded connection file."
          : "\nMerge the downloaded counsel entry into your client's MCP settings, preserving other servers. Reconnect your client and look for counsel_session.");
      download(
        filename,
        content,
        client === "codex" ? "text/plain" : "application/json",
      );
    } catch (e) {
      toast(e.message);
    }
  };
  $("#assistant-diagnose").onclick = async () => {
    const status = $("#assistant-diagnostic");
    status.textContent = "Checking current key permissions�";
    try {
      const response = await fetch("/agent/v1/session", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + data.token,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "Connection failed");
      status.textContent = `Workspace reachable. ${result.mode} key; ${result.matterCount} authorized matters; expires ${new Date(result.expires).toLocaleString()}. No model call. Now run counsel_session in your assistant to verify the client path and protocol.`;
    } catch (e) {
      status.textContent = e.message;
    }
  };
}
