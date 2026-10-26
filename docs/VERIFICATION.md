# Verification and release status

Repository: https://github.com/mehbul/counsel-workspace.

This record describes the `0.1.0` public preview. The repository was rebuilt from a sanitized history, so older private-repository commit hashes and Actions run IDs do not apply here. The local suite passes 188 tests. The frontend bundle build, formatting checks and dependency vulnerability audit pass locally. The repository's GitHub Actions workflows repeat those checks and add a Docker image build and hardened-container smoke test. Repository scans found no tracked runtime databases, private keys or recognized access-token patterns; this is a bounded check, not an independent security audit.

## Public verification record

On 26 October 2026, commit `c30c12b` passed the public repository checks:

- [Verify run 40315182757](https://github.com/mehbul/counsel-workspace/actions/runs/40315182757): 188 tests, build, format check, benchmark, dependency audit, Docker build and hardened-container smoke test.
- [CodeQL run 40315182726](https://github.com/mehbul/counsel-workspace/actions/runs/40315182726): JavaScript and TypeScript analysis with the security-extended query set.
- [Pages deployment 40315246135](https://github.com/mehbul/counsel-workspace/actions/runs/40315246135): the landing page at https://mehbul.github.io/counsel-workspace/.
- [Container release 40315533549](https://github.com/mehbul/counsel-workspace/actions/runs/40315533549): `ghcr.io/mehbul/counsel-workspace` tags `0.1.0`, `0.1`, `sha-c30c12b` and `latest`.

Tag `v0.1.0` points at this commit. None of these checks is an independent security or legal review.

## Verified behavior

- Anonymous APIs deny access. Owner setup needs a single-use local token. Password changes and disabled users revoke existing sessions.
- CSRF and cross-origin mutations are rejected; viewer accounts cannot modify content.
- Workspace isolation and explicit matter grants apply to reads, writes, exports and queued jobs.
- Concurrent matter writes persist without losing records. Durable review replay reuses saved output IDs.
- Text import, real PDF/DOCX parsing, corrupt-file rejection, source citations, review edits/locks and DOCX export pass tests.
- Two real Yjs WebSocket clients merge simultaneous edits, persist state and reconnect. Viewer updates, untrusted origins and revoked access are rejected.
- Owner/editor matter archives include a manifest, SHA-256SUMS, readable source text and structured records; owner exports include a capped audit subset and full exports include integrity-checked original files. Viewer, guest, revoked-editor and cross-matter access is denied. `scripts/verify-matter-archive.js` verifies metadata, full and empty-matter archives without extraction and rejects tampered payloads. ZIP tests cover corruption, truncation, unsafe paths, encryption and symbolic-link rejection, filename byte limits and case-insensitive duplicate paths. A headless Chromium download through the Documents export flow produced a metadata archive that the offline verifier accepted.
- Mock Microsoft and Google endpoints exercise folder imports, repeated sync, changed source versions, encrypted credentials and explicit DOCX export.
- SQLite online backups preserve committed WAL records, pass integrity checking and refuse to overwrite an existing backup.
- Browser checks covered login/logout, navigation, review workflow, evidence inspection, shared editor autosave, two-tab presence/content, and connector setup.
- Linux CI built the Docker image and started it with a read-only filesystem and restricted capabilities. Readiness succeeded and an anonymous state request returned HTTP 401.

## Not established

These checks do not establish full Legora parity, legal advice accuracy, independent security certification, or superiority over Legora. There has been no matched benchmark against its authenticated product.

Live enterprise provider consent, permission semantics and writeback need approved test tenants and credentials. Snapshot connectors do not mirror provider ACLs or source deletions. Rich-text collaboration, comments, checkpoints, DOCX revision export and an Office task-pane bridge are implemented, but full in-place Word tracked-change interoperability, tenant-installed Word/Outlook add-ins and anchored comments remain open. Licensed legal research, OCR, SSO/MFA, comprehensive external monitoring feeds, live Slack/Teams tenant acceptance and full DMS synchronization remain open. Matter archives are checksummed exports, not encrypted, signed or notarized records; there is no archive import/restore, and no matched export comparison with Legora exists. Public HTTPS deployment, realistic load, disaster-recovery drills and independent security and legal-domain review remain release gates.

The default improvement priorities are privacy, reliability and verifiable evidence. Any claim of being better should be based on a defined task corpus, blinded legal review, citation correctness, failure behavior, latency, cost and operational reliability—not a feature checklist or screenshots alone.
