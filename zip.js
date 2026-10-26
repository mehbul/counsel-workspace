const { crc32, deflateRawSync, inflateRawSync } = require("node:zlib");

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const MAX_ENTRIES = 10_000;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

const fail = (message, status = 400) =>
  Object.assign(Error(message), { status });
const pathKey = (value) => value.normalize("NFC").toLowerCase();

function safeArchivePath(value) {
  if (typeof value !== "string" || !value || value.length > 512)
    throw fail("Archive entry path is invalid.");
  if (value.includes("\\"))
    throw fail("Archive entry paths must use forward slashes.");
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value))
    throw fail("Archive entry paths must be relative.");
  if (/[\u0000-\u001f\u007f]/.test(value))
    throw fail("Archive entry path contains control characters.");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw fail("Archive entry path is unsafe.");
  return parts.join("/");
}

function dosDateTime(input) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) throw fail("Archive timestamp is invalid.");
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  return {
    date:
      ((year - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
  };
}

function asBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array)
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data ?? ""), "utf8");
}

function buildZip(entries, options = {}) {
  if (!Array.isArray(entries) || !entries.length)
    throw fail("An archive must contain at least one file.");
  if (entries.length > (options.maxEntries || MAX_ENTRIES))
    throw fail("Archive contains too many files.");
  const timestamp = dosDateTime(options.date || new Date()),
    chunks = [],
    central = [],
    names = new Set();
  let offset = 0,
    total = 0;
  for (const entry of entries) {
    const name = safeArchivePath(entry.path),
      key = pathKey(name),
      nameBytes = Buffer.from(name, "utf8"),
      data = asBuffer(entry.data),
      method = entry.store ? 0 : 8,
      payload =
        method === 8 ? deflateRawSync(data, { level: 6 }) : Buffer.from(data);
    if (names.has(key))
      throw fail(
        "Archive contains a duplicate path, including case-only duplicates.",
      );
    names.add(key);
    if (data.length > MAX_ENTRY_BYTES)
      throw fail("An archive entry exceeds the supported limit.", 413);
    total += data.length;
    if (total > (options.maxBytes || MAX_ARCHIVE_BYTES))
      throw fail("Archive exceeds the supported uncompressed limit.", 413);
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(timestamp.time, 10);
    local.writeUInt16LE(timestamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, payload);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8_FLAG, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(timestamp.time, 12);
    header.writeUInt16LE(timestamp.date, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

function readZip(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22)
    throw fail("The file is not a readable ZIP archive.");
  const maxEntry = options.maxEntryBytes || MAX_ENTRY_BYTES,
    maxTotal = options.maxBytes || MAX_ARCHIVE_BYTES,
    minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  let end = -1;
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (
      buffer.readUInt32LE(i) === END_SIGNATURE &&
      i + 22 + buffer.readUInt16LE(i + 20) === buffer.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw fail("The file has no valid ZIP end record.");
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0)
    throw fail("Multi-disk ZIP archives are not supported.");
  const count = buffer.readUInt16LE(end + 10),
    centralSize = buffer.readUInt32LE(end + 12),
    centralOffset = buffer.readUInt32LE(end + 16);
  if (!count || count === 0xffff || count > (options.maxEntries || MAX_ENTRIES))
    throw fail("ZIP entry count is invalid.");
  if (centralOffset + centralSize > end)
    throw fail("ZIP central directory is outside the file.");
  const files = [],
    seen = new Set();
  let position = centralOffset,
    total = 0;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end) throw fail("ZIP central directory is truncated.");
    if (buffer.readUInt32LE(position) !== CENTRAL_SIGNATURE)
      throw fail("ZIP central directory is invalid.");
    const flags = buffer.readUInt16LE(position + 8),
      method = buffer.readUInt16LE(position + 10),
      checksum = buffer.readUInt32LE(position + 16),
      compressedSize = buffer.readUInt32LE(position + 20),
      size = buffer.readUInt32LE(position + 24),
      nameLength = buffer.readUInt16LE(position + 28),
      extraLength = buffer.readUInt16LE(position + 30),
      commentLength = buffer.readUInt16LE(position + 32),
      localOffset = buffer.readUInt32LE(position + 42),
      nameEnd = position + 46 + nameLength,
      next = nameEnd + extraLength + commentLength;
    if (next > end) throw fail("ZIP central directory is truncated.");
    if (flags & 0x0001) throw fail("Encrypted ZIP entries are not supported.");
    if (flags & 0x0008) throw fail("ZIP data descriptors are not supported.");
    if (method !== 0 && method !== 8)
      throw fail("ZIP compression method is not supported.");
    if (compressedSize === 0xffffffff || size === 0xffffffff)
      throw fail("ZIP64 archives are not supported.");
    if (size > maxEntry)
      throw fail("A ZIP entry exceeds the supported limit.", 413);
    const madeBy = buffer.readUInt16LE(position + 4),
      external = buffer.readUInt32LE(position + 38);
    if (madeBy >> 8 === 3 && ((external >>> 16) & 0xf000) === 0xa000)
      throw fail("ZIP symbolic links are not supported.");
    const name = buffer.toString("utf8", position + 46, nameEnd);
    safeArchivePath(name);
    const key = pathKey(name);
    if (seen.has(key))
      throw fail(
        "ZIP contains a duplicate path, including case-only duplicates.",
      );
    seen.add(key);
    if (localOffset + 30 > centralOffset)
      throw fail("ZIP local header is outside the file.");
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE)
      throw fail("ZIP local header is invalid.");
    const localFlags = buffer.readUInt16LE(localOffset + 6),
      localMethod = buffer.readUInt16LE(localOffset + 8),
      localNameLength = buffer.readUInt16LE(localOffset + 26),
      localExtraLength = buffer.readUInt16LE(localOffset + 28),
      dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (
      localNameLength !== nameLength ||
      buffer.toString(
        "utf8",
        localOffset + 30,
        localOffset + 30 + localNameLength,
      ) !== name
    )
      throw fail("ZIP local and central names disagree.");
    if (localMethod !== method || localFlags !== flags)
      throw fail("ZIP local and central headers disagree.");
    if (dataStart + compressedSize > centralOffset)
      throw fail("ZIP entry data is outside the file.");
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(payload);
    else {
      try {
        data = inflateRawSync(payload, { maxOutputLength: size + 1 });
      } catch {
        throw fail("ZIP entry could not be decompressed.");
      }
    }
    if (data.length !== size)
      throw fail("ZIP entry size does not match its header.");
    if (crc32(data) >>> 0 !== checksum)
      throw fail("ZIP entry checksum does not match its content.");
    total += data.length;
    if (total > maxTotal)
      throw fail("ZIP archive exceeds the supported uncompressed limit.", 413);
    files.push({ name, data, method, crc32: checksum });
    position = next;
  }
  if (position !== centralOffset + centralSize)
    throw fail("ZIP central directory has an unexpected length.");
  return files;
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  buildZip,
  readZip,
  safeArchivePath,
};
