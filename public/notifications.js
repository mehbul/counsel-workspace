const notificationEventLabels = {
  "workflow.approval_required": "Workflow approval required",
  "workflow.completed": "Workflow completed",
  "workflow.failed": "Workflow failed",
  "workflow.cancelled": "Workflow cancelled",
  "monitor.alert": "Monitor alert",
};
const notificationKindLabels = {
  webhook: "Signed webhook",
  slack: "Slack incoming webhook",
  teams: "Microsoft Teams webhook",
};
let notificationChannels = [];
async function notificationGet(path) {
  const response = await fetch("/api/" + path, {
    headers: { Accept: "application/json" },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || "Request failed");
  return data;
}
async function loadNotifications() {
  const target = $("#notification-panel");
  if (!target) return;
  try {
    const [channels, deliveries] = await Promise.all([
      notificationGet("notification-channels"),
      notificationGet("notification-deliveries?limit=25"),
    ]);
    notificationChannels = channels;
    target.innerHTML = `<div class="notification-section"><div class="notification-title"><div><h2>Channels</h2><p>Alerts are delivered outside the workspace with a durable receipt for every attempt.</p></div></div>${
      channels.length
        ? `<div class="workflow-grid">${channels
            .map(
              (c) =>
                `<article class="workflow-card"><span class="pill">${esc(notificationKindLabels[c.kind] || c.kind)}</span><h2>${esc(c.name)}</h2><p class="muted">${esc(c.url)}</p><small>${c.enabled ? "Enabled" : "Paused"} · ${c.events.length} event${c.events.length === 1 ? "" : "s"}</small><p class="event-pills">${c.events.map((event) => `<span class="pill">${esc(notificationEventLabels[event] || event)}</span>`).join("")}</p><footer><button class="primary" onclick="testNotificationChannel('${c.id}')">Send test</button><button class="secondary" onclick="toggleNotificationChannel('${c.id}',${!c.enabled})">${c.enabled ? "Pause" : "Resume"}</button></footer><button class="textbutton" onclick="deleteNotificationChannel('${c.id}')">Delete channel</button></article>`,
            )
            .join("")}</div>`
        : `<div class="empty"><span>✉</span><h2>Route alerts to your team.</h2><p>Add a signed webhook, Slack incoming webhook or Microsoft Teams webhook. Test it before relying on it.</p><button class="primary" onclick="newNotificationChannel()">Add a channel</button></div>`
    }</div><div class="notification-section"><div class="notification-title"><div><h2>Recent deliveries</h2><p>Receipts record the response, attempt count and next retry. They remain after a channel is deleted.</p></div></div>${
      deliveries.length
        ? `<div class="tablewrap"><table class="reviewtable"><thead><tr><th>Status</th><th>Delivery</th><th>Channel</th><th>Attempts</th><th>Created</th><th>Detail</th></tr></thead><tbody>${deliveries
            .map((d) => {
              const detail =
                d.error ||
                (d.responseStatus ? `HTTP ${d.responseStatus}` : "") ||
                (d.status === "pending" && d.nextAttempt
                  ? `Retry ${new Date(d.nextAttempt).toLocaleString()}`
                  : "");
              return `<tr><td><span class="notification-status ${esc(d.status)}">${esc(d.status)}</span></td><td><strong>${esc(d.title)}</strong><br><small>${esc(notificationEventLabels[d.event] || d.event)}</small></td><td>${esc(d.channelName)}</td><td>${d.attempts}</td><td>${new Date(d.created).toLocaleString()}</td><td>${esc(detail)}${["dead", "pending"].includes(d.status) ? `<br><button class="textbutton" onclick="retryNotificationDelivery('${d.id}')">Retry now</button>` : ""}</td></tr>`;
            })
            .join("")}</tbody></table></div>`
        : `<p class="muted">No deliveries yet. Send a test to confirm your channel works.</p>`
    }</div>`;
  } catch (error) {
    target.innerHTML = `<div class="empty"><span>✉</span><h2>Notifications unavailable.</h2><p>${esc(error.message)}</p></div>`;
    toast(error.message);
  }
}
function notificationKindFields() {
  const kind = $("#notification-kind")?.value || "webhook";
  const secret = $("#notification-secret-field");
  if (secret) secret.style.display = kind === "webhook" ? "block" : "none";
  const url = $("#notification-url");
  if (url)
    url.placeholder =
      kind === "slack"
        ? "https://hooks.slack.com/services/…"
        : kind === "teams"
          ? "https://your-tenant.webhook.office.com/…"
          : "https://your-service.example.com/counsel-events";
  const hint = $("#notification-kind-hint");
  if (hint)
    hint.textContent =
      kind === "webhook"
        ? "Generic destinations receive JSON signed with HMAC-SHA256 in X-Counsel-Signature. HTTPS is required outside local testing."
        : kind === "slack"
          ? "Paste a Slack incoming webhook URL. The URL is the credential; Counsel stores it encrypted and adds no signing header."
          : "Paste a Microsoft Teams incoming webhook URL. The URL is the credential; Counsel stores it encrypted and sends a MessageCard.";
}
function newNotificationChannel() {
  modal(
    "Add notification channel",
    `<p>Only connect a destination approved by your organization. URLs and signing secrets are encrypted on this server. Private and internal targets are blocked outside local testing.</p><form id="notification-form">${field("name", "Channel name", "Operations alerts")}<label>Destination<select name="kind" id="notification-kind"><option value="webhook">Generic signed webhook</option><option value="slack">Slack incoming webhook</option><option value="teams">Microsoft Teams incoming webhook</option></select></label><label>Webhook URL<input name="url" id="notification-url" type="url" placeholder="https://your-service.example.com/counsel-events" required></label><label id="notification-secret-field">Signing secret — optional, 16+ characters<input name="secret" id="notification-secret" type="password" autocomplete="off" placeholder="Leave blank to generate one"></label><p class="muted" id="notification-kind-hint"></p><fieldset class="checkgrid"><legend>Events</legend>${Object.entries(
      notificationEventLabels,
    )
      .map(
        ([value, label]) =>
          `<label><input type="checkbox" name="events" value="${value}" checked> ${esc(label)}</label>`,
      )
      .join(
        "",
      )}</fieldset><label class="inline"><input type="checkbox" name="enabled" checked> Enabled</label><div class="modalfooter"><button type="button" class="secondary" onclick="$('#modal').close()">Cancel</button><button class="primary">Add channel</button></div></form>`,
  );
  notificationKindFields();
  $("#notification-kind").onchange = notificationKindFields;
  $("#notification-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target,
      submit = event.submitter,
      values = new FormData(form),
      body = {
        name: values.get("name"),
        kind: values.get("kind"),
        url: values.get("url"),
        events: values.getAll("events"),
        enabled: values.get("enabled") === "on",
      },
      secret = String(values.get("secret") || "").trim();
    if (body.kind === "webhook" && secret) body.secret = secret;
    submit.disabled = true;
    try {
      const created = await api("notification-channels", body);
      $("#modal").close();
      await loadNotifications();
      if (created.secret) showNotificationSecret(created.secret);
      else toast("Notification channel added.");
    } catch (error) {
      toast(error.message);
      submit.disabled = false;
    }
  };
}
function showNotificationSecret(secret) {
  modal(
    "Store this signing secret",
    `<p>This secret is shown once. Use it to verify <code>X-Counsel-Signature: v1=&lt;hex&gt;</code> over <code>timestamp.body</code>, where the timestamp comes from <code>X-Counsel-Timestamp</code>.</p><div class="secretbox" id="notification-secret-value">${esc(secret)}</div><p class="muted">Rotate it from the channel API if it is exposed. Delivery receipts never contain the secret.</p><div class="modalfooter"><button class="secondary" onclick="copyNotificationSecret()">Copy secret</button><button class="primary" onclick="$('#modal').close()">Done</button></div>`,
  );
}
function copyNotificationSecret() {
  const value = $("#notification-secret-value")?.textContent || "";
  if (!navigator.clipboard)
    return toast("Copy unavailable. Select the secret and copy it manually.");
  navigator.clipboard.writeText(value).then(
    () => toast("Secret copied."),
    () => toast("Copy failed. Select the secret and copy it manually."),
  );
}
async function testNotificationChannel(id) {
  try {
    const delivery = await api(`notification-channels/${id}/test`, {});
    toast(
      delivery.status === "delivered"
        ? "Test delivered."
        : `Test ${delivery.status}: ${delivery.error || `HTTP ${delivery.responseStatus}`}`,
    );
    await loadNotifications();
  } catch (error) {
    toast(error.message);
  }
}
async function toggleNotificationChannel(id, enabled) {
  try {
    await api(`notification-channels/${id}`, { enabled }, "PATCH");
    await loadNotifications();
    toast(enabled ? "Channel resumed." : "Channel paused.");
  } catch (error) {
    toast(error.message);
  }
}
function deleteNotificationChannel(id) {
  const channel = notificationChannels.find((c) => c.id === id);
  modal(
    "Delete notification channel?",
    `<p>${esc(channel?.name || "This channel")} will stop receiving alerts. Existing delivery receipts are retained as workspace history.</p><div class="modalfooter"><button class="secondary" onclick="$('#modal').close()">Cancel</button><button class="primary" id="notification-delete-confirm">Delete channel</button></div>`,
  );
  $("#notification-delete-confirm").onclick = async () => {
    try {
      await api(`notification-channels/${id}`, undefined, "DELETE");
      $("#modal").close();
      await loadNotifications();
      toast("Channel deleted.");
    } catch (error) {
      toast(error.message);
    }
  };
}
async function retryNotificationDelivery(id) {
  try {
    await api(`notification-deliveries/${id}/retry`, {});
    await loadNotifications();
    toast("Delivery queued for retry.");
  } catch (error) {
    toast(error.message);
  }
}
