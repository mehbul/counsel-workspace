const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildZip, readZip, safeArchivePath } = require("../zip");

test("ZIP writer and reader preserve entries and reject unsafe or corrupt archives", () => {
  const binary = Buffer.from([0, 1, 2, 255, 128, 64]),
    archive = buildZip([
      {
        path: "README.txt",
        data: "Read me.\n",
      },
      {
        path: "matter/résumé.json",
        data: '{"ok":true}\n',
      },
      {
        path: "originals/source.bin",
        data: binary,
        store: true,
      },
    ]),
    files = readZip(archive);
  assert.deepEqual(
    files.map((file) => file.name),
    ["README.txt", "matter/résumé.json", "originals/source.bin"],
  );
  assert.equal(files[0].data.toString("utf8"), "Read me.\n");
  assert.deepEqual(files[2].data, binary);
  assert.equal(files[2].method, 0);

  assert.throws(() =>
    buildZip([
      { path: "same.txt", data: "one" },
      { path: "same.txt", data: "two" },
    ]),
  );
  assert.throws(() =>
    buildZip([
      { path: "Same.txt", data: "one" },
      { path: "same.TXT", data: "two" },
    ]),
  );
  assert.throws(() => safeArchivePath("../outside.txt"));
  assert.throws(() => safeArchivePath("/outside.txt"));
  assert.throws(() => safeArchivePath("C:/outside.txt"));
  assert.throws(() => safeArchivePath("matter\\outside.txt"));
  assert.throws(() => safeArchivePath("matter//outside.txt"));

  const duplicateCase = Buffer.from(
    buildZip([
      { path: "a.txt", data: "one" },
      { path: "b.txt", data: "two" },
    ]),
  );
  let duplicateCursor = duplicateCase.indexOf(Buffer.from("b.txt"));
  while (duplicateCursor !== -1) {
    duplicateCase.write("A.TXT", duplicateCursor, 5, "utf8");
    duplicateCursor = duplicateCase.indexOf(
      Buffer.from("b.txt"),
      duplicateCursor + 5,
    );
  }
  assert.throws(() => readZip(duplicateCase), /duplicate path/i);

  const centralOffset = archive.readUInt32LE(archive.length - 6),
    symlink = Buffer.from(archive);
  symlink.writeUInt16LE(0x0314, centralOffset + 4);
  symlink.writeUInt32LE(0xa0000000, centralOffset + 38);
  assert.throws(() => readZip(symlink), /symbolic links/i);
  const encrypted = Buffer.from(archive);
  encrypted.writeUInt16LE(1, centralOffset + 8);
  assert.throws(() => readZip(encrypted), /encrypted/i);

  const localOffset = archive.indexOf(Buffer.from("originals/source.bin")) - 30,
    dataOffset =
      localOffset +
      30 +
      Buffer.byteLength("originals/source.bin") +
      archive.readUInt16LE(localOffset + 28),
    corrupt = Buffer.from(archive);
  corrupt[dataOffset] ^= 0xff;
  assert.throws(() => readZip(corrupt), /checksum|size|decompress/i);

  const truncated = Buffer.from(archive);
  truncated.writeUInt16LE(0, truncated.length - 12);
  assert.throws(() => readZip(truncated), /entry count|central directory/i);
});
