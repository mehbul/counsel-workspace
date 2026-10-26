const path = require("node:path");
function installAssistantSetup(app) {
  app.get("/api/assistant-setup", (req, res) => {
    res.set("Cache-Control", "no-store").json({
      adapterPath: path.join(__dirname, "mcp", "server.mjs"),
      nodePath: process.execPath,
      transports: ["stdio", "streamable-http"],
      httpPath: "/agent/v1/mcp",
      authentication: "matter-scoped bearer key",
      oauth: false,
      modelCalls: false,
    });
  });
}
module.exports = { installAssistantSetup };
