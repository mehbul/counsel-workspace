# Workflow comparison and implementation status

Reviewed 23 October 2026 against Legora's public product pages. This is an independent implementation. Authenticated Legora behavior and legal output quality have not been compared, so this document does not establish full parity.

| Workflow | Implemented here | Remaining difference |
|---|---|---|
| Matters and source documents | Matter permissions, version-aware imports, PDF/DOCX/text parsing, stable paragraph references | OCR and preservation of original document layout |
| Assistant and evidence | Matter-scoped retrieval, reusable skills, source opening, optional configured AI generation | Semantic/reranked search, autonomous planning and tool selection, quality evaluation against legal benchmarks |
| Tabular review | Document rows, prompt columns, evidence, edited values, review decisions, locks, CSV export | Rich extraction schemas, collaborative cell presence, large-scale parallel generation, advanced filtering/templates |
| Reusable workflows | Visual ordered-step builder; search, review, approval, draft and task steps; template versions; saved source selection and skill instructions; durable per-step execution | Conditional branching, autonomous replanning, external tool steps and scheduled runs |
| Human approval and delivery | Pause, inspect artifacts, approve/reject with identity and note, optimistic concurrency, cancellation and failed-step retry, links to Word export | Four-eyes approval policies and external delivery channels; creating a follow-up task does not establish that delivery occurred |
| Skills | Create, edit with version check, revision history, freeze instructions in workflow runs | A legally curated equivalent of Legora's advertised 250+ skill library and practice/jurisdiction taxonomy |
| Editor | Shared rich text, per-client undo/redo, whole-draft comments, checkpoints/restore, proposed edits with accept/reject, formatted DOCX export | Word tracked-change interoperability, anchored comments, cursor sharing, advanced tables/layout |
| Intake | Workspace request form, priority, accountable lawyer with matter access, status transitions, linked workflow, approved resolution | Email, Teams, Slack and MCP request ingestion; no unlicensed external guest entry point |
| Monitors | Baseline current matter documents, manually scan newly imported versions, source-backed alerts, dismiss or create a deduplicated task | Jurisdiction/topic legal-update feeds, licensed external sources, scheduled polling and notifications |
| Portal | Internal read-only accounts and explicit matter grants | A separate guest portal with document-level publication, branded client access, prompt-hidden workflow execution and guest isolation |
| Enterprise document integrations | Google Drive and Microsoft 365/SharePoint snapshot imports, bounded pagination/recursion, native Google Docs extraction, explicit new-DOCX export, encrypted connector secrets | iManage, NetDocuments, source ACL/ethical-wall synchronization, source deletion/revocation handling, version writeback and live tenant verification |
| Word and Outlook add-ins | DOCX import/export | Installable and tenant-tested add-ins, in-place comments/redlines and inbox context |
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

Workflow definitions and runs are stored separately from the JSON workspace state in the same SQLite database. The runner executes one step per turn through the existing workspace lock and rechecks its initiating user's active account and matter grants. It pauses before an approval step; an approval can be made by any current editor/owner with matter access, including the initiator. This is not an enforced two-person rule.

Each step gets a persistent artifact ID before execution. Replaying a step after process interruption reuses an existing review, draft, message or task. Completed outputs are retained on failure. Active running records become queued on startup. Run progress and external model inference are not one transaction; an interrupted AI request may be billed again on retry, but local output IDs prevent duplicate artifacts.

Source IDs are frozen at launch, and imported versions are immutable. Removing a selected source or revoking the initiating user's access causes execution to fail. Retry does not bypass current permissions. Workflow/library edits and approval decisions use expected versions/revisions to reject stale updates. Local keyword extraction is clearly presented as extraction; without a configured provider, draft steps return evidence excerpts rather than pretending to generate legal analysis.

Proposed editor edits replace a single exact, unique quote in current shared text. A changed/ambiguous quote is rejected. Accepted replacements preserve the starting text's formatting and broadcast through the collaboration engine. A pre-change checkpoint is saved. These proposals are not Office tracked changes.

## Verification

Automated coverage includes an approval-gated selected-document workflow, immutable template snapshot, stale version/approval conflicts, completion, simulated interruption after a committed task, no duplicate replay, permission revocation, retry and rejection, viewer restrictions, assignment access, invalid intake transitions, monitor deduplication and skill versions. Shared-editor tests cover accept/reject and collaborative propagation. Browser checks cover custom workflow building, source selection, approval through completion and intake assignment/routing.

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

This supplies a way for an existing assistant to plan and reason using Counsel tools. It does not establish a native autonomous agent or complete the other enterprise, research, portal and Office gaps above. SDK protocol tests pass; actual client registration and live model-quality evaluations remain separate deployment work.
