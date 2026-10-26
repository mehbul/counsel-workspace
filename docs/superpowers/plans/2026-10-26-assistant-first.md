# Assistant-first legal workspace implementation plan

**Goal:** Execute the seven improvement priorities approved in chat, preserving existing local work and making all completion claims evidence-based.

**Architecture:** Extend Express, SQLite and matter-scoped MCP. Keep host-assistant reasoning independent of server model APIs. Add bounded modules for connections, model profiles, document fidelity, retrieval and workflow decisions. Preserve current authorization, immutable source versions, explicit human approvals and personal mode.

**Global constraints:** Node >=24.15; repository stays private; no automatic paid model calls, downloads of model weights, external delivery, or publication. Existing changes are retained. Source text is untrusted. No claimed legal accuracy or Legora superiority without comparative evidence. User approved this scope in chat; proceed continuously.

## Tasks and acceptance

- [ ] 1. Connections and distribution: client-specific setup wizard, downloadable configurations and diagnostic tools; authenticated HTTP MCP where feasible; launch scripts and compatibility evidence. Own agent-api.js, mcp/, public/assistants.js and new connection modules/tests. Real SDK calls must verify scoping, revocation and write idempotency. Native client verification requires available installed clients/accounts.
- [ ] 2. Model profiles: encrypted workspace configuration, native Anthropic, explicit provider selection, token/context budgets, cancellation and usage metadata; usable configuration UI and test action. Own models.js, model-settings.js, public/models.js and new tests. Root integrates server hooks. Existing default evidence mode must remain network-free. No plaintext secret responses.
- [ ] 3. Document fidelity: original-file retention and authorized download, PDF page anchors, complete document comparison and real Word tracked-change export. Own document-files.js, redlines.js, parser files and tests. Root integrates routes/upload/UI hooks. Cover unauthorized access, removed documents and actual DOCX revision XML. OCR must be opt-in and availability reported honestly.
- [ ] 4. Retrieval and review: whole-document coverage reports, conservative missing-evidence handling, optional semantic retrieval with explicit configured inference, structured clause/risk schema and playbook evidence. Preserve exact quotation offsets. Test independently authored paraphrase, absence and cross-reference fixtures; preserve published baseline, report any new evaluation conditions honestly.
- [ ] 5. Workflows: conditional steps and scheduled execution with bounded durable state, permission rechecks, cancellation and MCP-safe operation. Tests must cover skipped branches, repeat schedules, revocation and restart behavior.
- [ ] 6. Research and operational readiness: extend authoritative-source filtering/provenance where a public API is usable, strengthen operational diagnostics/restore/load checks, reconcile the stale completion ledger. Clearly list licensed research, enterprise tenant tests, SSO/SCIM, external security review and comparative evaluation that cannot be substantiated locally.
- [ ] 7. Integration review: format, full automated suite, retrieval benchmark, browser acceptance and available live assistant acceptance. Review security boundaries and document exact results plus remaining gaps.

## External acceptance requirements

Legora comparison requires authorized access and identical blinded tasks. Licensed databases require access rights. iManage/NetDocuments, Office tenant installation and identity-provider acceptance require real service tenants. Lawyer-curated jurisdictional rules require qualified review. These are not fulfilled by mock adapters or generated documentation.

## Execution ledger

Started 26 October 2026 on codex/assistant-first-legal-workspace, preserving pre-existing uncommitted changes. Implementation in progress.
