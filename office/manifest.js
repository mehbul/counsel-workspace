const fs = require("node:fs");
const path = require("node:path");
function officeManifest(origin) {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error(
      "Word add-in requires an explicit HTTPS origin without credentials, path or query.",
    );
  const escaped = url.origin
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return fs
    .readFileSync(path.join(__dirname, "manifest.xml"), "utf8")
    .replaceAll("https://localhost:3443", escaped);
}
module.exports = { officeManifest };
