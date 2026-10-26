async function openModelSettings() {
  try {
    const response = await fetch("/api/model-settings");
    if (!response.ok)
      throw Error("Workspace owner access is required to configure models.");
    const profile = await response.json();
    modal(
      "Model settings",
      `<p>Evidence mode makes no model requests. Selecting another provider sends selected prompts and source excerpts to that provider when you ask for AI analysis. Saving does not call the provider. Connection tests may incur provider usage.</p><form id="model-settings-form"><label>Provider<select name="provider">${["evidence", "openai", "anthropic", "openai-compatible", "ollama"].map((value) => `<option value="${value}" ${profile.provider === value ? "selected" : ""}>${value}</option>`).join("")}</select></label><label>Model name<input name="model" value="${esc(profile.model || "")}" maxlength="200"></label><label>Base URL (compatible / Ollama)<input name="baseUrl" type="url" value="${esc(profile.baseUrl || "")}" placeholder="https://provider.example/v1"></label><label>New API key<input name="apiKey" type="password" autocomplete="new-password" placeholder="${profile.hasKey ? "Stored key present; leave blank to retain" : "Enter key explicitly"}"></label><label><input type="checkbox" name="clearKey"> Remove stored key</label><label>Context budget (tokens)<input type="number" name="contextTokens" min="1024" max="1000000" value="${profile.contextTokens}"></label><label>Maximum output tokens<input type="number" name="maxOutputTokens" min="64" max="32000" value="${profile.maxOutputTokens}"></label><p>Context checks use a conservative UTF-8 byte estimate. Choose budgets within the selected model's actual limits. Credentials are encrypted on this server and never displayed. Source: ${esc(profile.source)}.</p><div class="modalfooter"><button class="primary">Save settings</button><button type="button" class="secondary" id="model-test">Test saved connection</button><button type="button" class="secondary" id="model-reset">Use server defaults</button></div><p id="model-status" role="status"></p></form>`,
    );
    const form = document.querySelector("#model-settings-form"),
      status = document.querySelector("#model-status");
    form.onsubmit = async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      values.contextTokens = Number(values.contextTokens);
      values.maxOutputTokens = Number(values.maxOutputTokens);
      values.clearKey = form.elements.clearKey.checked;
      if (!values.apiKey) delete values.apiKey;
      try {
        const saved = await api("model-settings", values, "PUT");
        form.elements.apiKey.value = "";
        status.textContent = `Saved ${saved.provider}. No provider request was made.`;
        if (typeof refresh === "function") await refresh();
      } catch (error) {
        status.textContent = error.message;
      }
    };
    document.querySelector("#model-test").onclick = async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      status.textContent = "Testing saved configuration…";
      try {
        const result = await api("model-settings/test", {});
        status.textContent = `Connected to ${result.provider} / ${result.model} in ${result.elapsedMs} ms. Input tokens: ${result.usage.inputTokens ?? "not reported"}; output tokens: ${result.usage.outputTokens ?? "not reported"}.`;
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    };
    document.querySelector("#model-reset").onclick = async () => {
      try {
        await api("model-settings", {}, "DELETE");
        await openModelSettings();
        if (typeof refresh === "function") await refresh();
      } catch (error) {
        status.textContent = error.message;
      }
    };
  } catch (error) {
    toast(error.message);
  }
}
