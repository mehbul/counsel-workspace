# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-28

Opt-in local OCR for scanned PDFs, a hardened owner-only archive restore, and a
production HTTPS deployment guide with a strict-TLS deployment verifier.

### Added

- Owner-only matter archive restore (`POST /api/matters/archive/restore`): the
  offline verification pipeline runs before any write; identifier collisions
  fail closed with `409` unless `newIds=1` requests a remap of every archived
  record ID; side-effect state is explicitly converted (queued or running jobs
  restore as `failed` and never run, workflow schedules and research watches
  restore disabled, workflow runs without a final status restore as
  `cancelled`, portal publications restore verbatim including revoked state,
  audit rows are never restored); restored uploads are capped at 256 MiB; and
  the response reports per-record counts plus one warning per policy decision.
  The verifier is now a shared module (`matter-archive-verify.js`) reused by
  the CLI (`npm run verify:archive`) and the restore path.
- Opt-in local OCR for scanned PDF pages using Tesseract and Poppler, with
  bounded processing, preserved native-text pages and exact extracted-text anchors.
- Production HTTPS deployment guide and a certificate-validating deployment
  checker; backup checks now verify encrypted notification credentials too.

### Fixed

- Matter archive restores roll back database, audit and in-memory state together
  on failure. Owner authorization now runs before buffering an archive upload.

### Security

- Resolved all open high-severity CodeQL findings: the model encryption key
  and evaluation outputs are now created through exclusive `openSync("wx")`
  file descriptors instead of an existence check followed by a write; Google
  Drive folder identifiers are allowlisted instead of quote-escaped; and eCFR
  text sanitization removes tags to a fixed point and strips remaining angle
  brackets so no markup can survive.
- CodeQL now analyzes production code and skips the `test` directory, whose
  local fixture/loopback scaffolding generated recurring false positives.
- Remaining CodeQL findings in the MCP connection tools and the optional local
  smoke scripts were triaged and dismissed with written justifications.

## [0.1.0] - 2026-10-26

First public preview. This is a functional, self-hosted foundation, not a
production-certified or independently audited product.

### Added

- Personal mode with direct loopback access and synthetic seed data.
- Team mode with owner-created accounts, Argon2 password hashing, revocable
  sessions, CSRF and origin checks, rate limits, audit records, and
  owner/editor/viewer/guest roles.
- Matters, document import for PDF, DOCX, TXT, MD, and CSV, original-file
  retention, page and paragraph anchors, and OCR-needed reporting.
- Matter-scoped ranked passage search, deterministic clause anchors, optional
  semantic candidates, and conservative abstention.
- Review tables with prompt columns, evidence inspection, editable findings,
  locks, status, filtering, sorting, pagination, and CSV export.
- Document comparisons with highlighted passage changes, CSV export, DOCX
  revision export, and tracked insertions through the Office bridge.
- Editable rich-text drafts, comments, checkpoints, proposed edits, and DOCX
  export.
- Reusable instructions, versioned workflow templates, approval gates with
  independent approvers and quorum, durable runs, retries, cancellation, and
  schedules.
- Intake tracking, document monitors, and follow-up tasks.
- Guest-only client portal with explicit document and reviewed-text publication
  and immediate revocation.
- US Federal Register research and eCFR source imports with official-origin
  pinning, bounded requests, and publication watches.
- Owner-only encrypted notification channels for signed webhooks, Slack, and
  Microsoft Teams, with event subscriptions, durable retries, receipts, and
  manual retry.
- Owner/editor matter archives with a manifest, `SHA256SUMS`, readable source
  text, structured records, an owner audit subset, optional retained originals,
  independent metadata/original limits, and an offline verifier.
- MCP integration for scoped evidence reading and host-authored drafts, reviews,
  and tasks, with expiring and revocable keys.
- Optional local Ollama, OpenAI-compatible, and Anthropic generation. Generation
  is disabled by default and no model API is mandatory.
- Docker Compose deployment, hardened-container CI checks, online backup, and
  restore documentation.
- Apache License 2.0, NOTICE, third-party notices, security policy, contribution
  guide, code of conduct, privacy statement, and legal disclaimer.

### Security

- Workspace and matter isolation is enforced on reads, writes, exports, jobs,
  WebSockets, portal access, research, and MCP calls.
- Connector credentials and notification secrets are encrypted at rest.
- Outbound webhook and research requests reject private, loopback, link-local,
  and embedded-credential targets; public targets require HTTPS.
- The dependency-free ZIP reader rejects traversal, absolute paths, backslashes,
  control characters, duplicate paths, encryption, data descriptors, ZIP64,
  symlinks, unsupported methods, and checksum or size mismatches.
- A full-history secret scan is part of the release process.

### Known limitations

- No OCR; scanned PDFs require external OCR first.
- No SSO, SCIM, MFA, or enterprise directory integration.
- No iManage or NetDocuments adapter, and no provider ACL or ethical-wall sync.
- No archive import or restore command.
- Archives are checksummed but not encrypted, signed, or notarized.
- No multi-instance or high-availability mode.
- No independent security or legal review.
- The clause engine's document-disjoint CUAD validation score is 33.98%
  answerable-only token F1 and 77.05% answerability balanced accuracy. It is not
  a legal-accuracy guarantee and not a Legora comparison.
- The retrieval benchmark is synthetic and was designed alongside the
  implementation. It is a regression check, not held-out evidence.

### Verification

- `npm test` passes 188 tests locally.
- `npm run build`, `npm run format:check`, `npm run benchmark`, and
  `npm audit --omit=dev --audit-level=high` pass.
- GitHub CI builds the Docker image and smoke-tests a hardened container.
- A headless Chromium download of a matter archive was accepted by the offline
  verifier.

[0.2.0]: https://github.com/mehbul/counsel-workspace/releases/tag/v0.2.0
[0.1.0]: https://github.com/mehbul/counsel-workspace/releases/tag/v0.1.0
