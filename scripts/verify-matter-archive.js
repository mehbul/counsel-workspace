const fs = require("node:fs");
const { verifyArchive } = require("../matter-archive-verify");

if (require.main === module) {
  const args = process.argv.slice(2),
    json = args.includes("--json"),
    file = args.find((arg) => arg !== "--json");
  if (!file) {
    console.error(
      "Usage: node scripts/verify-matter-archive.js <archive.zip> [--json]",
    );
    process.exitCode = 2;
  } else {
    try {
      const result = verifyArchive(fs.readFileSync(file));
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Verified ${file}`);
        console.log(`Matter: ${result.matter.name} (${result.matter.id})`);
        console.log(
          `Mode: ${result.mode}; files: ${result.files}; uncompressed bytes: ${result.bytes}`,
        );
        console.log(
          `Documents: ${result.documents}; drafts: ${result.drafts}; originals: ${result.originals}`,
        );
        console.log(
          `Audit: ${result.auditAvailable ? `${result.auditRows} row(s)` : "unavailable"}`,
        );
        console.log(`Archive SHA-256: ${result.sha256}`);
      }
    } catch (error) {
      console.error(`Archive verification failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = { verifyArchive };
