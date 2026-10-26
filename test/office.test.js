const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { officeManifest } = require("../office/manifest");
const {
  createClient,
  readWordText,
  insertTrackedText,
} = require("../office/actions");

test("Word manifest uses requested HTTPS origin and rejects untrusted origin shapes", () => {
  const xml = officeManifest("https://counsel.example.test");
  assert.match(xml, /<Host Name="Document"/);
  assert.match(xml, /<Permissions>ReadWriteDocument<\/Permissions>/);
  assert.match(
    xml,
    /SourceLocation DefaultValue="https:\/\/counsel.example.test\/office\/taskpane.html"/,
  );
  assert.doesNotMatch(xml, /localhost/);
  for (const origin of [
    "http://remote.test",
    "https://user:pass@remote.test",
    "https://remote.test/path",
    "https://remote.test/?secret=abc",
  ])
    assert.throws(() => officeManifest(origin));
});

test("Office bridge uses only same-origin scoped bearer requests and disconnect clears its capability", async () => {
  const requests = [],
    token = "counsel_" + "a".repeat(64);
  const client = createClient(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ mode: "write" }) };
  }, token);
  await client.session();
  assert.equal(requests[0].url, "/agent/v1/session");
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.headers.Authorization, "Bearer " + token);
  client.disconnect();
  await assert.rejects(client.session(), /Connect/);
  assert.throws(() => createClient(() => {}, "invalid"));
  const taskpane = fs.readFileSync(
    path.join(__dirname, "../office/taskpane.js"),
    "utf8",
  );
  assert.doesNotMatch(taskpane, /localStorage|sessionStorage|indexedDB/);
});

test("draft reading follows all chunks and refuses incomplete or changing content", async () => {
  let calls = 0;
  const client = createClient(
    async () => ({
      ok: true,
      json: async () =>
        ++calls === 1
          ? { content: "first", characters: 11, nextOffset: 5 }
          : { content: "second", characters: 11, nextOffset: null },
    }),
    "counsel_" + "b".repeat(64),
  );
  assert.equal(
    (await client.readDraft("matter", "draft")).content,
    "firstsecond",
  );
  assert.equal(calls, 2);
  const incomplete = createClient(
    async () => ({
      ok: true,
      json: async () => ({
        content: "short",
        characters: 15,
        nextOffset: null,
      }),
    }),
    "counsel_" + "b".repeat(64),
  );
  await assert.rejects(incomplete.readDraft("matter", "draft"), /Incomplete/);
});

test("tracked insertion enables tracking before editing and restores previous mode", async () => {
  const events = [],
    doc = {
      changeTrackingMode: "Off",
      load: (field) => events.push(field),
      getSelection: () => ({
        insertText: (text, where) => {
          assert.equal(doc.changeTrackingMode, "TrackAll");
          events.push({ text, where });
        },
      }),
    };
  const word = {
    ChangeTrackingMode: { trackAll: "TrackAll" },
    InsertLocation: { end: "End" },
    run: (fn) =>
      fn({
        document: doc,
        sync: async () => events.push(doc.changeTrackingMode),
      }),
  };
  await insertTrackedText(
    word,
    {
      isSetSupported: (name, version) =>
        name === "WordApi" && version === "1.4",
    },
    "Reviewed clause",
  );
  assert.equal(doc.changeTrackingMode, "Off");
  assert.deepEqual(events, [
    "changeTrackingMode",
    "Off",
    "TrackAll",
    { text: "Reviewed clause", where: "End" },
    "TrackAll",
    "Off",
  ]);
  await assert.rejects(
    insertTrackedText(word, { isSetSupported: () => false }, "Text"),
    /requires WordApi 1.4/,
  );
});

test("tracking mode is restored after insertion fails; read does not mutate document", async () => {
  const doc = {
    changeTrackingMode: "TrackMineOnly",
    load() {},
    getSelection: () => ({
      insertText() {
        throw Error("host denied");
      },
      text: "Selected words",
      load() {},
    }),
  };
  const word = {
    ChangeTrackingMode: { trackAll: "TrackAll" },
    InsertLocation: { end: "End" },
    run: (fn) => fn({ document: doc, sync: async () => {} }),
  };
  await assert.rejects(
    insertTrackedText(word, { isSetSupported: () => true }, "Reviewed clause"),
    /host denied/,
  );
  assert.equal(doc.changeTrackingMode, "TrackMineOnly");
  assert.equal(await readWordText(word), "Selected words");
});
