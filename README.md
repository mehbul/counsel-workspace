# Counsel workspace

An independently implemented Legora-style legal workspace with authenticated local accounts and a self-hosted Docker deployment configuration. Original branding; based on the public workflow investigation in `legora-reconstruction.md`. This is a functional local prototype, not a complete or production-equivalent replica of Legora.

## Run

Requires Node 24.15 or newer.

```sh
npm install
npm start
```

Open http://127.0.0.1:3000. The service binds to loopback. SQLite data is stored in `data/workspace.db`. On first run, open the setup screen and use the one-time token in `data/bootstrap-token` to create the owner account. Existing prototype data is preserved and transferred to that owner. Three synthetic contracts seed new workspaces. Upload PDF, DOCX, TXT, MD or CSV documents (20 MB each). Scanned PDFs require external OCR first.

## Features

- Persistent matter creation, document import, text viewing, search and deletion.
- Matter-scoped assistant with clickable paragraph references.
- Review tables with prompt columns, evidence inspection, editable findings, locks and review status; CSV export.
- Editable drafting workspace and real DOCX export.
- Reusable instructions, three executable workflow templates, task lists and activity history.
- Responsive layout and accessible native forms/dialogs.

Local mode uses deterministic passage search, including basic clause synonym matching. Review tables extract matching passages; they do not use a legal reasoning model. Creating a draft in local mode compiles source excerpts. No external legal-research corpus or case-law verification is included.

## Optional generated analysis

Start with `OPENAI_API_KEY` in the server environment to enable generated assistant responses and drafts. `OPENAI_MODEL` optionally overrides `gpt-4.1-mini`. On Windows PowerShell:

```powershell
$env:OPENAI_API_KEY = 'your-key'
npm start
```

This sends the question and retrieved document passages to OpenAI and may incur provider charges. The UI reports whether a provider key is present; an invalid key produces an actionable request error. No key is bundled. The provider path requires a valid key and was not live-tested without one.

## Verify

```sh
npm test
```

Integration tests use isolated in-memory databases and temporary data directories. They verify import, scoped citations, extraction, locks, edits and DOCX export.

## Self-hosted deployment

See [deployment and operations](docs/OPERATIONS.md) for Docker Compose, HTTPS, initial setup, members, matter access, backup/restore and release gates. Docker build and live deployment have not been verified on this Windows host because Docker is unavailable.

## Boundaries

Authentication, workspace isolation, matter grants, local accounts, revocable sessions, owner-managed members, persisted background review/draft jobs and audit records are implemented. This remains a single-instance foundation, not an independently audited production equivalent of Legora. Licensed research, OCR, rich-text collaboration, Office add-ins, full DMS permission synchronization and monitoring are still missing. Plain-text Yjs collaboration and Microsoft/Google snapshot connectors are implemented; see docs/COLLABORATION-AND-CONNECTORS.md. Extracted text is stored rather than original-file layout. Review tables still use deterministic passage extraction; generated assistant/draft analysis requires a configured provider. Read the operations document before deployment.
