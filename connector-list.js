const GRAPH = "https://graph.microsoft.com",
  GOOGLE = "https://www.googleapis.com";
async function collectFiles(config, read) {
  const queue = [config.folderId],
    folders = new Set(),
    files = [],
    seenFiles = new Set();
  let pages = 0,
    partial = false;
  while (queue.length) {
    const folder = queue.shift();
    if (folders.has(folder)) continue;
    if (folders.size >= 50) {
      partial = true;
      break;
    }
    folders.add(folder);
    let next, googleToken;
    do {
      if (pages++ >= 64 || files.length >= 1000) {
        partial = true;
        break;
      }
      let url;
      if (config.provider === "microsoft") {
        url =
          next ||
          `${GRAPH}/v1.0/drives/${encodeURIComponent(config.driveId)}/${folder === "root" ? "root" : "items/" + encodeURIComponent(folder)}/children?$top=200&$select=id,name,eTag,size,file,folder`;
        const parsed = new URL(url);
        if (
          parsed.origin !== GRAPH ||
          !parsed.pathname.startsWith(
            "/v1.0/drives/" + encodeURIComponent(config.driveId) + "/",
          ) ||
          parsed.username ||
          parsed.password
        )
          throw Error("Invalid provider continuation URL");
      } else {
        const params = new URLSearchParams({
          q: `'${folder.replace(/'/g, "\\'")}' in parents and trashed = false`,
          fields: "nextPageToken,files(id,name,modifiedTime,size,mimeType)",
          pageSize: "200",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
        });
        if (googleToken) params.set("pageToken", googleToken);
        url = GOOGLE + "/drive/v3/files?" + params;
      }
      const result = await read(url),
        items = config.provider === "microsoft" ? result.value : result.files;
      if (!Array.isArray(items)) throw Error("Malformed provider file listing");
      for (const item of items) {
        if (typeof item.id !== "string" || typeof item.name !== "string")
          throw Error("Malformed provider item");
        const isFolder =
          config.provider === "microsoft"
            ? !!item.folder
            : item.mimeType === "application/vnd.google-apps.folder";
        if (isFolder) {
          if (config.recursive && !folders.has(item.id)) queue.push(item.id);
          continue;
        }
        if (config.provider === "microsoft" && !item.file) continue;
        if (seenFiles.has(item.id)) continue;
        seenFiles.add(item.id);
        if (files.length >= 1000) {
          partial = true;
          break;
        }
        const nativeDoc =
          item.mimeType === "application/vnd.google-apps.document";
        files.push({
          id: item.id,
          name: nativeDoc ? item.name + ".docx" : item.name,
          etag:
            config.provider === "microsoft"
              ? item.eTag || ""
              : item.modifiedTime || "",
          size: Number(item.size || 0),
          nativeDoc,
        });
      }
      next = result["@odata.nextLink"];
      googleToken = result.nextPageToken;
      if (next !== undefined && typeof next !== "string")
        throw Error("Invalid continuation");
      if (
        googleToken !== undefined &&
        (typeof googleToken !== "string" || googleToken.length > 4096)
      )
        throw Error("Invalid continuation");
    } while (config.provider === "microsoft" ? next : googleToken);
    if (partial) break;
  }
  return { files, hasMore: partial };
}
module.exports = { collectFiles };
