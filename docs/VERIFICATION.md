# Verification and release status

Repository: https://github.com/mehbul/counsel-workspace (private).

Code commit `491be71` passed [GitHub CI run 40299010215](https://github.com/mehbul/counsel-workspace/actions/runs/40299010215) on 26 October 2026. The same 185 tests passed locally. The frontend bundle build, formatting checks, dependency vulnerability audit, Docker image build and hardened-container smoke test passed. Repository scans found no tracked runtime databases, private keys or recognized access-token patterns; this is a bounded check, not an independent security audit.

## Verified behavior

- Anonymous APIs deny access. Owner setup needs a single-use local token. Password changes and disabled users revoke existing sessions.
- CSRF and cross-origin mutations are rejected; viewer accounts cannot modify content.
- Workspace isolation and explicit matter grants apply to reads, writes, exports and queued jobs.
- Concurrent matter writes persist without losing records. Durable review replay reuses saved output IDs.
- Text import, real PDF/DOCX parsing, corrupt-file rejection, source citations, review edits/locks and DOCX export pass tests.
- Two real Yjs WebSocket clients merge simultaneous edits, persist state and reconnect. Viewer updates, untrusted origins and revoked access are rejected.
- Mock Microsoft and Google endpoints exercise folder imports, repeated sync, changed source versions, encrypted credentials and explicit DOCX export.
- SQLite online backups preserve committed WAL records, pass integrity checking and refuse to overwrite an existing backup.
- Browser checks covered login/logout, navigation, review workflow, evidence inspection, shared editor autosave, two-tab presence/content, and connector setup.
- Linux CI built the Docker image and started it with a read-only filesystem and restricted capabilities. Readiness succeeded and an anonymous state request returned HTTP 401.

## Not established

These checks do not establish full Legora parity, legal advice accuracy, independent security certification, or superiority over Legora. There has been no matched benchmark against its authenticated product.

Live enterprise provider consent, permission semantics and writeback need approved test tenants and credentials. Snapshot connectors do not mirror provider ACLs or source deletions. Rich-text collaboration, comments, checkpoints, DOCX revision export and an Office task-pane bridge are implemented, but full in-place Word tracked-change interoperability, tenant-installed Word/Outlook add-ins and anchored comments remain open. Licensed legal research, OCR, SSO/MFA, comprehensive external monitoring feeds, external notifications and full DMS synchronization are still missing. Public HTTPS deployment, realistic load, disaster-recovery drills and independent security and legal-domain review remain release gates.

The default improvement priorities are privacy, reliability and verifiable evidence. Any claim of being better should be based on a defined task corpus, blinded legal review, citation correctness, failure behavior, latency, cost and operational reliability—not a feature checklist or screenshots alone.
