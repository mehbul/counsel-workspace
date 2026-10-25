[![Verify](https://github.com/mehbul/counsel-workspace/actions/workflows/ci.yml/badge.svg)](https://github.com/mehbul/counsel-workspace/actions/workflows/ci.yml)

# Counsel workspace

A self-hosted legal workspace that Codex, Claude Code and compatible MCP assistants can use without a Legora subscription. Run it with evidence-only retrieval, your existing assistant, or a locally served model. No paid model API is required, and generation is disabled by default. The repository remains private for now. This is an independent implementation, not full Legora parity or a production-equivalence claim.

See [assistant and local-model setup](docs/ASSISTANTS.md) for Codex, Claude, other MCP clients and DeepSeek-compatible model options. See [the remaining parity gaps](docs/WORKFLOW-PARITY.md) for what still needs building and verification.

## Run

Requires Node 24.15 or newer.

```sh
npm ci
npm start
```

Open http://127.0.0.1:3000. The service binds to loopback. SQLite data is stored in `data/workspace.db`. On first run, open the setup screen and use the one-time token in `data/bootstrap-token` to create the owner account. Existing prototype data is preserved and transferred to that owner. Three synthetic contracts seed new workspaces. Upload PDF, DOCX, TXT, MD or CSV documents (20 MB each). Scanned PDFs require external OCR first.

## Features

- Persistent matter creation, document import, text viewing, search and deletion.
- Matter-scoped ranked passage search, explicit source selection and clickable paragraph references.
- Persisted document comparisons with source coverage, highlighted passage changes and CSV export.
- Reference-integrity reports that check exact quotes and flag missing sources or uncited output paragraphs.
- Review tables with prompt columns, evidence inspection, editable findings, locks, review status, filtering, sorting and pagination; CSV export.
- Editable drafting workspace and real DOCX export.
- Reusable instructions, three executable workflow templates, task lists and activity history.
- MCP tools for scoped evidence reading and host-authored drafts, review tables and tasks, with expiring/revocable read or write keys.
- Optional local Ollama or OpenAI-compatible model generation; explicit provider selection prevents accidental API usage.
- Responsive layout and accessible native forms/dialogs.

Evidence-only mode uses deterministic BM25-style passage ranking, legal-concept aliases, document diversity and bounded exact-quote windows. Its review tables extract matching passages and its drafts compile source excerpts. Connected assistants can instead reason over those sources and save their own unreviewed analyses, without Counsel making model API calls. No external legal-research corpus or case-law verification is included.

## Optional generated analysis

For local generation without a paid model API, follow the Ollama setup in [ASSISTANTS.md](docs/ASSISTANTS.md). To explicitly enable the optional OpenAI API path, set both `AI_PROVIDER=openai` and `OPENAI_API_KEY`. `OPENAI_MODEL` optionally overrides `gpt-4.1-mini`. On Windows PowerShell:

```powershell
$env:AI_PROVIDER = 'openai'
$env:OPENAI_API_KEY = 'your-key'
npm start
```

This optional path sends the question and retrieved passages to OpenAI and may incur provider charges. No key is bundled. The UI reports model configuration, not live endpoint health. Live provider/model quality has not been verified here. Set `AI_PROVIDER=evidence` to disable generation. MCP host reasoning uses the connected assistant's own plan and limits; a cloud assistant receives returned source text under its provider policy.

## Verify

```sh
npm test
npm run benchmark
```

Integration tests use isolated in-memory databases and temporary data directories. They verify import, scoped citations, comparisons, reference checks, source selection, extraction, locks, edits, collaboration, security regressions and DOCX export. See [quality checks and measured limits](docs/QUALITY.md) for the synthetic retrieval baseline and live assistant acceptance test.

## Self-hosted deployment

See [deployment and operations](docs/OPERATIONS.md) for Docker Compose, HTTPS, initial setup, members, matter access, backup/restore and release gates. GitHub CI verified the Docker image build, hardened container startup and anonymous API rejection. Live HTTPS deployment and enterprise provider connections remain unverified.

## Boundaries

Authentication, workspace isolation, matter grants, local accounts, revocable sessions, owner-managed members, persisted background review/draft jobs and audit records are implemented. This remains a single-instance foundation, not an independently audited production equivalent of Legora. Licensed research, OCR, Office add-ins, full DMS permission synchronization and monitoring are still missing. Rich-text Yjs collaboration, comments, checkpoints and Microsoft/Google snapshot connectors are implemented; see docs/COLLABORATION-AND-CONNECTORS.md. Extracted text is stored rather than original-file layout. Review tables still use deterministic passage extraction; generated assistant/draft analysis requires a configured provider. Read the operations document before deployment.

## Workflow orchestration

The Workflows library now supports an ordered-step builder, versioned definitions, selected sources, durable runs, approval gates, retry/cancel and links to resulting reviews/drafts/tasks. Intake tracks requests and responsible lawyers; document monitors turn new matching evidence into follow-up tasks. Skills have revision history, and shared drafts support proposed edits with accept/reject. See [workflow comparison and remaining gaps](docs/WORKFLOW-PARITY.md) for the exact implementation and limits.
