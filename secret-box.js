const {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function createSecretBox(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const keyPath = path.join(dataDir, "integration-key");
  try {
    fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) throw Error("Invalid integration encryption key");
  const seal = (value) => {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([
      iv,
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  };
  const open = (value) => {
    const b = Buffer.from(value, "base64"),
      cipher = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(-16));
    return JSON.parse(
      Buffer.concat([
        cipher.update(b.subarray(12, -16)),
        cipher.final(),
      ]).toString(),
    );
  };
  return { seal, open };
}

module.exports = { createSecretBox };
