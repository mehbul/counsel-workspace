import { loadConnection } from "./server.mjs";
// Reads only connection metadata and scoped matter count. Never prints the key or source text.
try {
  const file = process.argv[process.argv.indexOf("--connection-file") + 1];
  const connection = loadConnection(
    process.argv.includes("--connection-file")
      ? file
      : process.env.COUNSEL_CONNECTION_FILE,
  );
  const response = await fetch(connection.origin + "/agent/v1/session", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: "Bearer " + connection.token,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || `HTTP ${response.status}`);
  console.log(
    JSON.stringify(
      {
        reachable: true,
        mode: result.mode,
        authorizedMatters: result.matterCount,
        expires: new Date(result.expires).toISOString(),
        modelCalls: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    "Connection check failed: " +
      (error.message === "fetch failed"
        ? "Start Counsel and check the URL."
        : error.message),
  );
  process.exitCode = 1;
}
