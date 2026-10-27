const { test } = require("node:test");
const assert = require("node:assert/strict");
const { originFor, verify } = require("../scripts/verify-deployment");
function endpoint(url) {
  if (url.startsWith("http:"))
    return {
      status: 308,
      headers: { location: url.replace("http:", "https:") },
    };
  if (url.endsWith("/health/live"))
    return { status: 200, body: '{"status":"ok"}' };
  if (url.endsWith("/health/ready"))
    return { status: 200, body: '{"status":"ready"}' };
  if (url.endsWith("/api/state"))
    return { status: 401, headers: { "cache-control": "no-store" } };
  return {
    status: 200,
    headers: {
      "strict-transport-security": "max-age=31536000",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'",
    },
  };
}
test("requires an HTTPS origin without credentials or suffixes", () => {
  for (const value of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com/?x=1",
    "https://example.com/#x",
  ])
    assert.throws(() => originFor(value));
});
test("accepts the expected deployed endpoint contract", async () => {
  assert.equal((await verify("https://example.com", endpoint)).ok, true);
});
test("fails closed for broken health, headers, authorization, redirect and TLS", async () => {
  for (const path of ["/health/ready", "/", "/api/state"]) {
    await assert.rejects(
      verify("https://example.com", (url) =>
        url === "https://example.com" + path
          ? { status: 200, body: "{}", headers: {} }
          : endpoint(url),
      ),
    );
  }
  await assert.rejects(
    verify("https://example.com", (url) =>
      url.startsWith("http:")
        ? { status: 308, headers: { location: "https://attacker.example/" } }
        : endpoint(url),
    ),
  );
  await assert.rejects(
    verify("https://example.com", () => {
      throw Error("certificate has expired");
    }),
    /certificate has expired/,
  );
});
