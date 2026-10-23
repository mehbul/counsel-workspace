const { test } = require("node:test");
const assert = require("node:assert/strict");
const { collectFiles } = require("../connector-list");
test("Google paginated recursive listing imports native docs once and avoids folder cycles", async () => {
  const calls = [];
  const result = await collectFiles(
    { provider: "google", folderId: "root", recursive: true },
    async (raw) => {
      const u = new URL(raw);
      calls.push(u);
      const q = u.searchParams.get("q");
      if (q.startsWith("'child'"))
        return {
          files: [
            {
              id: "root",
              name: "Cycle",
              mimeType: "application/vnd.google-apps.folder",
            },
            {
              id: "doc",
              name: "Memo",
              mimeType: "application/vnd.google-apps.document",
            },
          ],
        };
      if (u.searchParams.has("pageToken"))
        return {
          files: [
            {
              id: "doc",
              name: "Memo",
              mimeType: "application/vnd.google-apps.document",
            },
          ],
        };
      return {
        nextPageToken: "page 2",
        files: [
          {
            id: "child",
            name: "Subfolder",
            mimeType: "application/vnd.google-apps.folder",
          },
        ],
      };
    },
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[1].searchParams.get("pageToken"), "page 2");
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, "Memo.docx");
  assert.equal(result.files[0].nativeDoc, true);
  assert.equal(result.hasMore, false);
});
test("Graph continuation never sends credentials to another host or drive", async () => {
  for (const next of [
    "https://evil.test/steal",
    "https://graph.microsoft.com/v1.0/drives/other/root/children",
  ]) {
    let calls = 0;
    await assert.rejects(
      collectFiles(
        { provider: "microsoft", driveId: "drive", folderId: "root" },
        async () => {
          calls++;
          return { value: [], "@odata.nextLink": next };
        },
      ),
      /Invalid provider continuation/,
    );
    assert.equal(calls, 1);
  }
});
test("Graph follows valid pages and reports bounded traversal", async () => {
  let calls = 0;
  const result = await collectFiles(
    { provider: "microsoft", driveId: "drive", folderId: "root" },
    async () => {
      calls++;
      return {
        value: [{ id: String(calls), name: "memo.txt", file: {} }],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/drives/drive/root/children?$skiptoken=" +
          calls,
      };
    },
  );
  assert.equal(calls, 64);
  assert.equal(result.files.length, 64);
  assert.equal(result.hasMore, true);
});
