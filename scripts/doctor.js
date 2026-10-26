const path = require("node:path");
const { inspectDatabase } = require("./restore-check");
const { modelConfiguration } = require("../models");
function doctor(env = process.env) {
  const directory = env.DATA_DIR || path.join(__dirname, "..", "data");
  const config = modelConfiguration(env),
    production = env.NODE_ENV === "production",
    personal = env.COUNSEL_PERSONAL === "true";
  const nodeParts = process.versions.node.split(".").map(Number);
  const checks = [
    {
      name: "supported Node runtime",
      ok: nodeParts[0] > 24 || (nodeParts[0] === 24 && nodeParts[1] >= 15),
    },
    {
      name: "production HTTPS and secure cookie configuration",
      ok:
        !production ||
        (/^https:\/\//.test(env.APP_ORIGIN || "") &&
          env.COOKIE_SECURE === "true"),
    },
    {
      name: "personal mode is local and nonproduction",
      ok:
        !personal ||
        (!production &&
          ["127.0.0.1", "::1", "localhost"].includes(env.HOST || "127.0.0.1") &&
          env.TRUST_PROXY !== "1"),
    },
    {
      name: "selected server model configuration",
      ok: config.provider === "evidence" || config.enabled,
    },
  ];
  const database = inspectDatabase(
    env.COUNSEL_DB || path.join(directory, "workspace.db"),
    { keyDir: directory },
  );
  return {
    ok: checks.every((check) => check.ok) && database.ok,
    checks,
    database,
    mode: personal ? "personal" : "authenticated",
    model: { provider: config.provider, enabled: config.enabled },
    capabilities: {
      research: ["federal-register", "ecfr"],
      liveProviderAccess: "not checked",
      externalTenantIntegration: "not checked",
      licensedResearch: "not provided",
    },
    notice:
      "Read-only local checks. No credentials, document text, tokens, provider requests or external network calls are emitted. This is not a security audit or production acceptance.",
  };
}
if (require.main === module) {
  const report = doctor();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
module.exports = { doctor };
