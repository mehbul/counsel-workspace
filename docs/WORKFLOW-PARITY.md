# Workflow comparison and implementation status

Reviewed 23 October 2026 against Legora's public product pages; implementation status updated 26 October 2026. This is an independent implementation. Authenticated Legora behavior and legal output quality have not been compared, so this document does not establish full parity.

| Workflow | Implemented here | Remaining difference |
|---|---|---|
| Matters and source documents | Matter permissions, version-aware imports, PDF/DOCX/text parsing, stable paragraph references | OCR and preservation of original document layout |
| Matter export and portability | Owner/editor checksummed matter archive with manifest, readable source text, structured records, referenced skills, owner audit subset and optional retained originals; dependency-free ZIP writer and offline verifier | No archive import/restore, encryption or signature; no matched export comparison with Legora |
| Assistant and evidence | Matter-scoped lexical and semantic evidence retrieval, legal aliases, reusable skills, selected sources, reference-integrity reports, optional configured AI generation | Autonomous planning and tool selection, independent legal reasoning and cross-product comparison; a document-disjoint CUAD extraction evaluation now measures a bounded public-data baseline in LEGAL-EVALUATION.md |
| Tabular review | Document rows, prompt columns, evidence, edited values, review decisions, locks, search/status filtering, sorting, 25-row pagination, CSV export | Rich extraction schemas, collaborative cell presence, large-scale parallel generation, column-specific filtering/templates |
| Document comparison | Saved comparisons of 2–6 explicit source versions, complete word-level comparison, question-specific passage coverage, CSV export and DOCX revision export | Semantic legal comparison and in-place Office tracked-change review |
| Reusable workflows | Visual ordered-step builder; search, review, approval, draft and task steps; template versions; saved source selection and skill instructions; durable per-step execution, conditional branches and scheduled runs | Autonomous replanning and bounded external tool steps |
| Human approval and delivery | Pause, inspect artifacts, approve/reject with identity and note, optional independent approver and two-reviewer quorum, current-access revalidation, optimistic concurrency, cancellation and failed-step retry, links to Word export; encrypted notification channels with HMAC-signed delivery and durable receipts | Email delivery and live Slack/Teams tenant acceptance; delivered webhooks confirm transport, not that a person read or acted on the message |
| Skills | Create, edit with version check, revision history, freeze instructions in workflow runs | A legally curated equivalent of Legora's advertised 250+ skill library and practice/jurisdiction taxonomy |
| Editor | Shared rich text, per-client undo/redo, whole-draft comments, checkpoints/restore, proposed edits with accept/reject, formatted DOCX export | Full in-place Word tracked-change interoperability, anchored comments, cursor sharing, advanced tables/layout |
| Intake | Workspace request form, priority, accountable lawyer with matter access, status transitions, linked workflow, approved resolution | Email, Teams, Slack and MCP request ingestion; no unlicensed external guest entry point |
| Monitors | Baseline current matter documents and manually scan imports; public Federal Register publication watches with scheduled scans, deduplicated in-app alerts, explicit partial-coverage errors and optional external alert delivery | Broader jurisdiction/topic feeds, licensed sources and comprehensive change/subsequent-treatment tracking |
| Portal | Separate guest accounts and page, explicit recipient/matter-scoped document snapshots and reviewed-text publication, source/account/publication revocation, internal API/MCP/socket isolation | Guest workflow execution, richer branding, original-file presentation and workflow prompt hiding |
| Enterprise document integrations | Google Drive and Microsoft 365/SharePoint snapshot imports, bounded pagination/recursion, native Google Docs extraction, explicit new-DOCX export, encrypted connector secrets | iManage, NetDocuments, source ACL/ethical-wall synchronization, source deletion/revocation handling, version writeback and live tenant verification |
| Word and Outlook add-ins | Office task-pane bridge and manifest, same-origin scoped bearer requests, draft reading, tracked insertion, DOCX import/export and DOCX revision export | Tenant-installed Word/Outlook add-ins, in-place comments/redlines, Outlook mail context and desktop/tenant acceptance |
| Identity and operations | Self-hosted Docker, local accounts, owner/editor/viewer roles, sessions/CSRF, audits, backups and container smoke tests | SSO/SCIM intentionally deferred by initial local-account choice; multi-replica distribution, external audit and live TLS deployment are not verified |

## Run the implemented end-to-end flow

1. Import sources into a matter and grant reviewers appropriate access.
2. Open Workflows and choose Contract diligence, NDA first pass or Litigation evidence review, or create a workflow with ordered steps.
3. Start a run with instructions and selected source versions. Existing runs retain their template and expanded skill instructions when the library changes.
4. Open Run history. Inspect the tabular review when the run reaches its approval gate. Approve to continue, or reject/cancel.
5. Open the produced draft, collaborate, propose/accept edits and export to Word. Review follow-up tasks in Lists.
6. Alternatively, create an Intake request, assign an active lawyer with matter access and start a linked workflow. Record a resolution after the linked workflow completes before closing the request.
7. Use Monitors for new imports into the matter. A matching alert opens its source and can create one follow-up task.

## Execution and recovery contract

Workflow definitions and runs are stored separately from the JSON workspace state in the same SQLite database. The runner executes one step per turn through the existing workspace lock and rechecks its initiating user's active account and matter grants. It pauses before an approval step; by default a current editor/owner with matter access can approve, including the initiator. An approval step can require independent reviewers and one or two distinct approvals. Its frozen policy excludes the initiator when configured, revalidates current reviewer grants, and is checked again before subsequent side effects.

Each step gets a persistent artifact ID before execution. Replaying a step after process interruption reuses an existing review, draft, message or task. Completed outputs are retained on failure. Active running records become queued on startup. Run progress and external model inference are not one transaction; an interrupted AI request may be billed again on retry, but local output IDs prevent duplicate artifacts.

Source IDs are frozen at launch, and imported versions are immutable. Removing a selected source or revoking the initiating user's access causes execution to fail. Retry does not bypass current permissions. Workflow/library edits and approval decisions use expected versions/revisions to reject stale updates. Local keyword extraction is clearly presented as extraction; without a configured provider, draft steps return evidence excerpts rather than pretending to generate legal analysis.

Proposed editor edits replace a single exact, unique quote in current shared text. A changed/ambiguous quote is rejected. Accepted replacements preserve the starting text's formatting and broadcast through the collaboration engine. A pre-change checkpoint is saved. These proposals are not Office tracked changes.

## Matter portability and export

Owners and editors can export the current matter as a versioned ZIP. Metadata mode contains matter records, every document version as readable text, drafts, comparisons, monitors, workflow runs/schedules, current referenced templates and skills, legal operations, portal publications, jobs, comments, checkpoints, suggestions and an owner-only audit subset. Full mode additionally includes exact retained original files after rechecking their size and SHA-256 against the database.

`manifest.json` lists the payload, `SHA256SUMS` covers every file except itself, and `X-Counsel-Archive-SHA256` identifies the whole ZIP. `scripts/verify-matter-archive.js` checks the ZIP without extraction. Owners receive a best-effort audit subset capped at 10,000 rows; editors receive an explicitly unavailable audit. Defaults are 128 MiB of metadata/source text, 128 MiB of originals and 4,000 entries. Viewers, guests, revoked editors and cross-matter requests are denied.

The archive is not encrypted or digitally signed, is not a workspace backup, and has no import or restore command. Raw Yjs history, users, model settings, connector credentials and notification channels are excluded. See [MATTER-ARCHIVE.md](MATTER-ARCHIVE.md) for the layout, limits, warnings and verification commands.

## Notification delivery

Owners can configure generic signed webhooks, Slack incoming webhooks and Microsoft Teams incoming webhooks. Channels subscribe to `workflow.approval_required`, `workflow.completed`, `workflow.failed`, `workflow.cancelled` and `monitor.alert`. URLs and signing secrets are encrypted at rest with AES-256-GCM under the workspace integration key. Generic deliveries carry `X-Counsel-Signature: v1=<hex>`, `X-Counsel-Timestamp` and `X-Counsel-Event`; the signature covers `${timestamp}.${body}`. Slack and Teams URLs are treated as credentials and receive no custom signature header.

Delivery is queued durably and retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours, up to five attempts. Every attempt stores a receipt with status, response code, safe response excerpt, error and next attempt. Receipts survive channel deletion. Owners can retry a failed delivery manually and can send a test to one selected channel.

Webhook target validation rejects embedded credentials, fragments and non-HTTP(S) schemes; public targets require HTTPS; private, link-local, loopback and internal hostnames are blocked; redirects are not followed and the resolved address is pinned. `ALLOW_PRIVATE_WEBHOOKS=true` permits private/local targets and plain HTTP for local testing only and must not be enabled in a shared deployment. No real Slack or Teams tenant was available for acceptance, so those payloads are verified against local receivers only.

## Verification

Automated coverage includes an approval-gated selected-document workflow, immutable template snapshot, stale version/approval conflicts, completion, simulated interruption after a committed task, no duplicate replay, permission revocation, retry and rejection, viewer restrictions, assignment access, invalid intake transitions, monitor deduplication and skill versions. Notification tests cover owner-only channel and receipt access, encrypted storage, HMAC verification against a local receiver, event filtering, deduplication, retry/backoff and manual retry, test isolation, workflow approval/completion/cancellation/failure events, monitor alerts, private-address rejection and receipt retention after deletion. Matter-archive tests cover owner/editor export, viewer/guest/revoked/cross-matter denial, metadata and full downloads, manifest/count/checksum verification, tamper rejection, independent metadata/original limits, referenced skills, orphaned-original omission, owner and editor audit behavior, audit truncation, empty matters, limits and ZIP path/corruption/encryption/symlink handling. A headless Chromium download through the Documents export flow produced a metadata archive that the offline verifier accepted; this is not a cross-product or legal-quality comparison. Shared-editor tests cover accept/reject and collaborative propagation. Browser checks cover custom workflow building, source selection, approval through completion and intake assignment/routing. Clause anchoring, abstention and exact offsets have targeted tests plus the document-disjoint CUAD results in [LEGAL-EVALUATION.md](LEGAL-EVALUATION.md).

## Public references

- [Legora Workflows](https://legora.com/product/workflows)
- [Legora Agent](https://legora.com/product/agent)
- [Legora Skills](https://legora.com/product/skills)
- [Legora Intake](https://legora.com/product/intake)
- [Legora Monitors](https://legora.com/product/monitors)
- [Legora Editor](https://legora.com/product/editor)
- [Legora Portal](https://legora.com/product/portal)
- [Legora integrations](https://legora.com/product/integrations)

Public descriptions establish advertised features, not private implementation or independently measured behavior.

## Assistant-powered operation added 25 October 2026

The repository now includes a stdio MCP bridge with matter-scoped, expiring and revocable keys. A connected assistant can read evidence and save its own unreviewed drafts, structured reviews and tasks without Counsel calling a model API. Ollama and OpenAI-compatible generation adapters are also available; model APIs require explicit provider selection and are optional. See [ASSISTANTS.md](ASSISTANTS.md).

This supplies a way for an existing assistant to plan and reason using Counsel tools. It does not establish a native autonomous agent or complete the other enterprise, research, portal and Office gaps above. SDK protocol tests and a live Codex CLI acceptance flow pass; real Claude client registration and broader independent legal-quality evaluations remain unverified.
