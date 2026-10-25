# Quality checks and measured limits

Updated 25 October 2026. These checks measure this repository's behavior. They do not establish legal accuracy, production equivalence, or superiority over Legora.

## Retrieval regression benchmark

Run `npm run benchmark` to compare the former substring search with the current deterministic passage ranker on `test/fixtures/retrieval-benchmark.json`. The fixture contains 16 answerable queries and six queries with no matching evidence. It was designed alongside the implementation; it is small, synthetic, and not held out.

| Metric | Previous substring search | Current ranker |
|---|---:|---:|
| Answerable queries with expected paragraph in first three results | 6/16 (37.5%) | 16/16 (100%) |
| Mean reciprocal rank at three | 0.375 | 1.000 |
| Missing-evidence queries returning any passage | 4/6 (66.7%) | 0/6 (0%) |

The ranker uses token boundaries, BM25-style scoring, bidirectional legal aliases, heading weighting and document diversity. Long paragraphs are clipped around matching text while retaining exact offsets and original paragraph anchors. Superseded documents are excluded by default and remain available when explicitly selected. Instructions for a saved skill do not alter retrieval keywords.

This is lexical retrieval. A matching word can still retrieve irrelevant evidence, and different wording can still be missed. A generic summary request can return an overview of supplied sources; a specific missing topic should return no evidence. Embedding search, independent legal datasets, blinded evaluation, and comparative Legora testing remain outstanding.

## Compare source versions

Open **Compare**, choose a matter, then **New comparison**. Select two to six source versions and enter up to twelve questions. Each source gets matching passages or an explicit no-match result. Open the original paragraph before interpreting a finding. Expand the wording comparison to see additions and deletions between the first passages from the first two selected sources. Export the table as CSV.

Reports persist immutable extracted passages and source IDs. If a source is removed later, the report warns that it is unavailable. Previous versions are labeled. Comparison uses retrieved excerpts, not every word in each document. Highlighted differences do not establish legal equivalence, and no matching passage does not establish that a provision is absent. CSV fields are quoted and spreadsheet formula prefixes neutralized.

## Inspect references

Assistant answers, drafts and review findings provide **Check references** controls. The check reruns against currently available matter documents, rather than trusting a saved success label. It verifies document availability, paragraph anchors, exact quoted substrings, and previous-version status. For analysis text it also checks numeric reference markers and identifies substantive paragraphs lacking inline references. Deterministic excerpt output has a separate exact-excerpt format check.

Structured review findings check their linked quotations only. The report explicitly says their output text and interpretation were not evaluated. A matching quotation or a reference in a paragraph does not prove that the source supports the claim. Source authenticity, current law, completeness, entailment and legal conclusions require human assessment. Deleted sources and altered quotes should produce warnings. Draft edits can invalidate references; check again after editing.

## Review large tables

Tabular review supports search across document names and findings, reviewed/unreviewed/locked row filters, document-name or unreviewed-first sorting, and 25 document rows per page. Rows match when any finding satisfies the filter; filters do not hide individual cells. Large cells show a bounded preview and open their full text in the finding dialog. CSV export includes the complete review, regardless of current filters.

## Automated and live checks

`npm test` uses isolated databases and synthetic documents. Coverage includes source selection, previous versions, no-evidence generation guards, comparisons, CSV handling, reference checks, access revocation, collaborative editing, durable workflow execution, real PDF/DOCX parsing, and the MCP bridge over actual stdio. Test concurrency is capped at two to avoid exhausting memory and starving bounded parser subprocesses on developer machines. The production parser retains its 30-second limit.

`node scripts/smoke-codex.js` optionally exercises the signed-in Codex CLI with only Counsel MCP tools: it reads a synthetic NDA and saves a quoted review and memorandum. It uses normal Codex account allowance, no separate model API through Counsel, and temporary credentials that are revoked after the check. It preserves saved client configuration. Claude and DeepSeek client compatibility require separate live verification.

CI builds and starts the Docker image with a read-only root filesystem, restricted capabilities and a temporary writable data volume. Local account login, a single server instance and SQLite are the supported deployment foundation. Independent security review, real enterprise-tenant tests, large-corpus load tests, a live TLS deployment and held-out legal-quality evaluation remain release work for their respective environments.

## Security regressions addressed

Malformed WebSocket JSON primitives close only the sender instead of crashing the server. Password changes, recovery and member disabling revoke assistant keys as well as sessions. Login sessions are rechecked after asynchronous password hashing before sensitive account writes. MCP operation names must be own properties of the operation registry, and write permission is rechecked inside the workspace queue. Regression tests exercise these behaviors; they are not a security certification.
