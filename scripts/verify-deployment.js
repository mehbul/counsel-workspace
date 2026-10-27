const https = require("node:https");
const http = require("node:http");
const assert = require("node:assert/strict");

function originFor(input) {
  const url = new URL(input);
  assert(url.protocol === "https:", "An HTTPS origin is required");
  assert(
    !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "Supply only an HTTPS origin without credentials, path or query",
  );
  return url.origin;
}
function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? https : http).get(
      url,
      { headers, rejectUnauthorized: true },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1024 * 1024)
            req.destroy(Error("Response exceeded 1 MiB"));
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body }),
        );
        res.on("error", reject);
      },
    );
    const timer = setTimeout(
      () => req.destroy(Error("Request exceeded 15 seconds")),
      15000,
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
  });
}
async function verify(input, get = request) {
  const origin = originFor(input);
  for (const [path, expected] of [
    ["/health/live", "ok"],
    ["/health/ready", "ready"],
  ]) {
    const res = await get(origin + path);
    assert.equal(res.status, 200, path);
    assert.equal(JSON.parse(res.body).status, expected, path);
  }
  const page = await get(origin + "/");
  assert.equal(page.status, 200, "Homepage");
  assert.match(
    page.headers["strict-transport-security"] || "",
    /max-age=[1-9]\d*/i,
    "HSTS",
  );
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert(page.headers["content-security-policy"], "CSP missing");
  const denied = await get(origin + "/api/state");
  assert.equal(denied.status, 401, "Anonymous API must reject access");
  assert.match(denied.headers["cache-control"] || "", /no-store/i);
  const crossOrigin = await get(origin + "/api/state", {
    "Sec-Fetch-Site": "cross-site",
  });
  assert.equal(
    crossOrigin.status,
    401,
    "Anonymous cross-site read must reject access",
  );
  const redirect = await get(
    origin.replace("https:", "http:") + "/health/live",
  );
  assert([301, 302, 307, 308].includes(redirect.status), "HTTP must redirect");
  assert.equal(
    new URL(redirect.headers.location, origin).href,
    origin + "/health/live",
    "Redirect destination",
  );
  return {
    origin,
    ok: true,
    checks: [
      "trusted TLS",
      "liveness",
      "readiness",
      "security headers",
      "anonymous rejection",
      "HTTP redirect",
    ],
  };
}
if (require.main === module) {
  verify(process.argv[2])
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error("Deployment verification failed:", error.message);
      process.exitCode = 1;
    });
}
module.exports = { originFor, verify, request };
