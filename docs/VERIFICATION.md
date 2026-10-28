# Verification and release status

Repository: https://github.com/mehbul/counsel-workspace.

This record describes the public releases. The repository was rebuilt from a sanitized history, so older private-repository commit hashes and Actions run IDs do not apply here. The local suite passes 200 tests; two real-OCR checks skip without installed engines locally and run in CI with engines installed. The frontend bundle build, formatting checks and dependency vulnerability audit pass locally. The repository's GitHub Actions workflows repeat those checks and add a Docker image build and hardened-container smoke test. Repository scans found no tracked runtime databases, private keys or recognized access-token patterns; this is a bounded check, not an independent security audit.

## Public verification record

On 26 October 2026, commit `c30c12b` passed the public repository checks:

- [Verify run 40315182757](https://github.com/mehbul/counsel-workspace/actions/runs/40315182757): 188 tests, build, format check, benchmark, dependency audit, Docker build and hardened-container smoke test.
- [CodeQL run 40315182726](https://github.com/mehbul/counsel-workspace/actions/runs/40315182726): JavaScript and TypeScript analysis with the security-extended query set.
- [Pages deployment 40315246135](https://github.com/mehbul/counsel-workspace/actions/runs/40315246135): the landing page at https://mehbul.github.io/counsel-workspace/.
- [Container release 40315533549](https://github.com/mehbul/counsel-workspace/actions/runs/40315533549): `ghcr.io/mehbul/counsel-workspace` tags `0.1.0`, `0.1`, `sha-c30c12b` and `latest`.

Tag `v0.1.0` points at this commit. None of these checks is an independent security or legal review.

On 26 October 2026, the upstream commits `f98db6b` and `dc187e5` also passed [Verify run 40318988516](https://github.com/mehbul/counsel-workspace/actions/runs/40318988516) with 188 tests, and [CodeQL run 40318988513](https://github.com/mehbul/counsel-workspace/actions/runs/40318988513) on the security-extended query set.

## CodeQL triage

The first public CodeQL runs reported 22 open alerts: 4 high and 18 medium. All 4 high-severity findings were fixed in code in `f98db6b` and no longer appear:

- `model-settings.js` and `scripts/evaluate-legal.js` created files after an existence check; they now create files through exclusive `openSync("wx")` file descriptors and treat `EEXIST` as "already exists".
- `connector-list.js` quote-escaped Google Drive folder identifiers, which cannot escape backslashes; folder identifiers are now allowlisted against `^[A-Za-z0-9_-]{1,200}$` and rejected otherwise.
- `ecfr-source.js` stripped markup in one pass and decoded entities afterwards; sanitization now decodes entities first, removes tags repeatedly until the result stops changing, and finally removes any remaining angle brackets, so no markup can survive into plain text.

Test scaffolding by design reads its own local fixture tokens and writes temporary connection files for loopback servers, which permanently matches file-to-HTTP pattern queries. The CodeQL configuration (`.github/codeql-config.yml`) therefore excludes the `test` directory, leaving production code analyzed in full. The five remaining medium findings were triaged and dismissed as false positives with written justifications recorded on each alert: the MCP server and diagnostic tool fetch only the operator-created connection file's own origin and token (trusted local configuration, documented in the threat model), and the optional local smoke scripts read their own ephemeral bootstrap tokens and write temporary connection files for loopback-only servers. As of 26 October 2026 there are no open code-scanning, secret-scanning or Dependabot alerts. This remains a bounded static-analysis result, not an independent security audit.

## Verified behavior

- Anonymous APIs deny access. Owner setup needs a single-use local token. Password changes and disabled users revoke existing sessions.
- CSRF and cross-origin mutations are rejected; viewer accounts cannot modify content.
- Workspace isolation and explicit matter grants apply to reads, writes, exports and queued jobs.
- Concurrent matter writes persist without losing records. Durable review replay reuses saved output IDs.
- Text import, real PDF/DOCX parsing, corrupt-file rejection, source citations, review edits/locks and DOCX export pass tests.
- Two real Yjs WebSocket clients merge simultaneous edits, persist state and reconnect. Viewer updates, untrusted origins and revoked access are rejected.
- Owner/editor matter archives include a manifest, SHA-256SUMS, readable source text and structured records; owner exports include a capped audit subset and full exports include integrity-checked original files. Viewer, guest, revoked-editor and cross-matter access is denied. `scripts/verify-matter-archive.js` verifies metadata, full and empty-matter archives without extraction and rejects tampered payloads. ZIP tests cover corruption, truncation, unsafe paths, encryption and symbolic-link rejection, filename byte limits and case-insensitive duplicate paths. A headless Chromium download through the Documents export flow produced a metadata archive that the offline verifier accepted.
- Owner-only restore (`POST /api/matters/archive/restore`) passed tests for role denial (editor, viewer, guest, anonymous), tampered and cross-matter rejection, full restore of a generated archive into the database and workspace state (including re-attached original bytes), the side-effect policy (queued jobs store as `failed` and never execute, schedules and research watches restore disabled, final runs restore verbatim, portal publications restore as recorded) and collision handling (409 without `newIds`; remapped restore with `newIds=1` keeps run, template and skill references internally consistent).
- Mock Microsoft and Google endpoints exercise folder imports, repeated sync, changed source versions, encrypted credentials and explicit DOCX export.
- SQLite online backups preserve committed WAL records, pass integrity checking and refuse to overwrite an existing backup.
- Browser checks covered login/logout, navigation, review workflow, evidence inspection, shared editor autosave, two-tab presence/content, and connector setup.
- Linux CI built the Docker image and started it with a read-only filesystem and restricted capabilities. Readiness succeeded and an anonymous state request returned HTTP 401.

## Not established

These checks do not establish full Legora parity, legal advice accuracy, independent security certification, or superiority over Legora. There has been no matched benchmark against its authenticated product.

Live enterprise provider consent, permission semantics and writeback need approved test tenants and credentials. Snapshot connectors do not mirror provider ACLs or source deletions. Rich-text collaboration, comments, checkpoints, DOCX revision export and an Office task-pane bridge are implemented, but full in-place Word tracked-change interoperability, tenant-installed Word/Outlook add-ins and anchored comments remain open. Licensed legal research, OCR, SSO/MFA, comprehensive external monitoring feeds, live Slack/Teams tenant acceptance and full DMS synchronization remain open. Matter archives are checksummed exports, not encrypted, signed or notarized records, and no matched export comparison with Legora exists. Archive restore is owner-only and was tested against generated archives only; restores from other products or upgrade paths from older schema versions are not established. Public HTTPS deployment, realistic load, disaster-recovery drills and independent security and legal-domain review remain release gates.

The default improvement priorities are privacy, reliability and verifiable evidence. Any claim of being better should be based on a defined task corpus, blinded legal review, citation correctness, failure behavior, latency, cost and operational reliability—not a feature checklist or screenshots alone.

## Preview issue fixes — 27 October 2026

Archive restore now rolls back auxiliary rows, retained originals, audit and in-memory workspace state on late persistence failure; regression checks compare every affected table and then retry successfully. Owner access is checked before archive buffering.

Local verification passed 198 tests with two real-OCR checks skipped (no Tesseract installed). Linux CI run [40462755052](https://github.com/mehbul/counsel-workspace/actions/runs/40462755052) passed the real Tesseract/Poppler checks, including scanned/mixed PDF anchors and actual app upload followed by cited matter search. Build, synthetic retrieval benchmark and production dependency audit passed. This is functional OCR evidence, not a legal accuracy or competitor benchmark.

The HTTPS guide and verifier are implemented; real public DNS, certificate issuance and browser acceptance have not been exercised because no deployment server/domain was supplied. Locally the maintainer has run: `caddy validate` against the shipped Caddyfile (Caddy 2.11.7); the backup script (including refusal of existing and relative destinations), `scripts/restore-check.js` with the key directory, and an isolated restore boot whose `/health/ready` was 200 and whose restored session worked; and an end-to-end HTTPS pass on `https://localhost` through the real Caddy binary using the shipped Caddyfile directives with the upstream address swapped to the local app — production-mode app, `scripts/verify-deployment.js` exit 0 with `NODE_EXTRA_CA_CERTS` pointing at Caddy's locally issued root (strict TLS, liveness, readiness, security headers, anonymous rejection, HTTP redirect), a session cookie with `Secure; HttpOnly; SameSite=Strict`, authenticated `/api/state` over HTTPS, the sign-in rate limit keyed through the proxy (429 after 15 attempts), an authorized WebSocket upgrade on `/collaboration` (101) with anonymous upgrades rejected. Docker Compose topology and container runtime behavior were not exercised on this machine (no Docker installed); CI validates the compose configuration, the Caddyfile inside the caddy image, the image build and the hardened smoke test. Issue #6 was closed with this evidence; the remaining operator acceptance items (a real public hostname with a browser-verified certificate) are documented in DEPLOYMENT.md, and `site/product.json` keeps `productionDeploymentDrill: false` until an operator completes them.
