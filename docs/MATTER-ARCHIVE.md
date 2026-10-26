# Matter archive exports

Counsel can export one matter as a ZIP archive containing its records, readable source text, checksums and an optional copy of retained original files. This is a portability feature for a matter, not a full workspace backup and not an import format.

The implementation is in `matter-archive.js` and `zip.js`, the routes are registered by `server.js`, and the offline verifier is `scripts/verify-matter-archive.js`.

## Access and endpoints

An owner or editor with current access to the matter can export it. Viewers and client-portal guests receive `403`. An editor whose matter grant was revoked receives `404`, as does a request for a matter in another workspace.

| Endpoint | Purpose |
|---|---|
| `GET /api/matters/:id/archive/preview` | JSON counts, estimated sizes, warnings and audit availability. No archive is built. |
| `GET /api/matters/:id/archive?originals=0` | Metadata and source-text archive. This is the default. |
| `GET /api/matters/:id/archive?originals=1` | Full archive including retained original files. |

`originals` accepts `0`, `1`, `false` or `true`; other values return `400`. A full export with no retained originals also returns `400`. The archive response includes `X-Counsel-Archive-SHA256`, which is the SHA-256 of the complete ZIP file. The export event is written to the workspace audit after the ZIP is built, so it is not part of that archive's audit subset.

The Documents page exposes the same flow through **Export matter**. It previews metadata and full modes before download and reports the first 16 characters of the archive hash.

## Archive layout

```text
README.txt
manifest.json
SHA256SUMS
matter/
  matter.json
  documents.json
  messages.json
  reviews.json
  drafts.json
  tasks.json
  comparisons.json
  research-watches.json
  workflow-runs.json
  workflow-schedules.json
  workflow-templates.json
  skills.json
  legal-operations.json
  portal-publications.json
  jobs.json
  draft-comments.json
  draft-checkpoints.json
  draft-suggestions.json
  originals.json
  audit.json
documents/
  0001-<safe document name>.txt
drafts/
  0001-<safe draft title>.txt
originals/                 only in a full archive
  0001-<safe original name>
```

`matter/documents.json` and `matter/drafts.json` hold metadata plus the path, byte length and SHA-256 of each readable text file. All document versions in the matter are included, including superseded versions. Draft bodies are exported as plain text; structured checkpoint and suggestion records retain their stored data.

`matter/skills.json` contains the current workspace definitions for skills referenced by archived workflow templates or by a run's frozen step snapshots. Workflow runs retain their own instructions and skill-version fields. If a referenced skill no longer exists, the archive includes a warning. Workflow templates are the current definitions, so a run that used an older template version is also reported in the warnings.

## What is excluded

The archive is deliberately scoped to one matter. It excludes:

- Workspace users, accounts, sessions, assistant keys and matter-access records.
- Model settings, connector credentials, the integration key and notification channels.
- Raw Yjs collaboration history and the live collaborative-draft binary state.
- Full template version history and records belonging to other matters.
- Retained originals that no current document references.

The last case exists for stale database rows. Those files are omitted with a warning rather than silently attaching unrelated bytes to the matter.

## Modes and limits

Metadata mode includes structured records, readable document and draft text, checksums and an owner audit subset when available. It lists retained originals with `path: null`; it does not include the bytes.

Full mode requires at least one retained original and includes exact bytes under `originals/`. Before writing an original, the exporter compares its byte length and SHA-256 with the database metadata and returns `409` if they disagree. Originals are stored uncompressed in the ZIP; other entries are deflated.

Default limits:

| Limit | Value |
|---|---|
| Metadata archive entries (uncompressed) | 128 MiB |
| Retained original bytes | 128 MiB |
| ZIP entries | 4,000 |
| Audit rows | 10,000 |

Over-limit exports return `413`. The metadata and retained-original limits apply independently. The audit cap is applied with a deterministic global ordering and a warning; the complete audit table remains in the workspace. The archive builder also rejects case-insensitive duplicate archive paths so extraction on Windows and default macOS filesystems cannot overwrite one payload with another, and limits generated file names to 180 UTF-8 bytes so they fit common filesystem component limits. The ZIP reader rejects path traversal, absolute paths, backslashes, control characters, encrypted entries, data descriptors, ZIP64, symbolic links, duplicate paths, unsupported compression methods and checksum or size mismatches.

## Audit subset

Owners receive a best-effort audit subset in `matter/audit.json`. It matches rows whose `resource` is the matter ID or the ID of an archived record, including referenced workflow templates and skills. Workspace-level template or skill events can therefore appear when the matter references those records. Events without a matching archived resource are omitted. The subset is capped at 10,000 rows by default. Editors receive `available: false` with no rows and a note that audit records are owner-only.

The audit is not an independently immutable ledger. Host administrators can alter the source database. The archive checksum protects the exported bytes only after they exist; it does not prove that the workspace audit was complete or untampered before export.

## Verification

From a Counsel workspace checkout:

```sh
npm run verify:archive -- path/to/archive.zip
node scripts/verify-matter-archive.js path/to/archive.zip --json
```

The verifier reads the ZIP without extracting it. It checks the ZIP structure and bounds, required files, `SHA256SUMS` coverage, manifest-listed sizes and hashes, manifest count consistency, readable-text path prefixes, case-insensitive duplicate payload paths, original-file mode and count consistency, and audit-availability/count consistency. It does not evaluate the legal content or prove who created the archive.

After extraction, the standard checksum workflow also works:

```sh
sha256sum -c SHA256SUMS
```

On macOS use `shasum -a 256 -c SHA256SUMS`. On Windows PowerShell, compare each file with `Get-FileHash -Algorithm SHA256`; `sha256sum` is not built in.

`SHA256SUMS` covers every file except itself, including `manifest.json`. `manifest.json` lists `README.txt` and every payload file with its size and SHA-256, but does not list itself or `SHA256SUMS`, avoiding a circular dependency. The whole-ZIP digest is returned in the HTTP response header and is not stored inside the archive.

## Security and non-goals

The archive is not encrypted and not digitally signed. Checksums detect changes made without updating `SHA256SUMS`; they do not establish provenance, identity, approval or non-repudiation. A recipient who can replace both a payload and the checksum file can produce a self-consistent forged archive.

Archives can contain confidential client material, source text, internal identifiers, audit records and client-portal recipient IDs. Store and transfer them under the matter's confidentiality rules and check the destination before downloading a full export.

There is no import, restore, merge or migration command. Re-importing an archive is not supported. Use the SQLite backup and restore procedure in [OPERATIONS.md](OPERATIONS.md) for whole-workspace recovery.

## Test coverage

`test/matter-archive.test.js` covers owner/editor export, viewer and anonymous denial, revocation, cross-matter isolation, metadata and full downloads, checksum verification, tamper rejection, independent metadata/original limits, referenced skills, orphaned-original omission, owner and editor audit behavior, audit truncation, empty-matter behavior and configured limits. `test/zip.test.js` covers round trips, stored entries, corruption, truncation, unsafe paths, case-insensitive duplicate detection, encryption rejection and symbolic-link rejection. The verifier is exercised against generated metadata, full and empty-matter archives. A headless Chromium download of the Documents export flow produced a metadata archive that the verifier accepted; this is a local browser check, not a cross-product comparison.

These are local behavioral tests. They do not establish legal accuracy, production security certification, cross-product export parity or that an archive is a complete representation of a matter.
