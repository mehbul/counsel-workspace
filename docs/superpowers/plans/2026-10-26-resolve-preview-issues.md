# Resolve public preview issues

User request: complete remaining work and resolve GitHub issues. Baseline: main 81ccb9f, clean checkout. GitHub open issues are #4 local scanned-PDF OCR and #6 production HTTPS deployment guide; Dependabot PR #7 is separate. Preserve existing features and honest verification boundaries.

## Implementation and acceptance ledger

- [x] Archive restore safety: reproduce a late persistence failure; transaction/savepoint must roll back every table, audit and workspace-state mutation; restore in-memory context on failure; successful retry must work. Check current permission and role before upload processing.
- [x] Issue #4: operator-enabled local OCR, disabled by default, bounded external process/page/time/output limits; preserve native-text pages in mixed PDFs; same exact page anchors as existing parser; unavailable engines report actionable errors; live scanned fixture extraction and app search acceptance. Document install and enabling, without runtime downloads or cloud inference.
- [ ] Issue #6: complete Caddy HTTPS guide, origins/cookies/proxy/upload/WebSocket settings, encrypted backup key handling and tested restore drill. Exercise available local deployment commands. Public DNS/certificate acceptance requires user's server/domain and cannot be claimed from local mock tests.
- [ ] Integrate: meaningful automated tests, format/build/benchmark/dependency checks, browser flows where available, code review and targeted fixes. Reconcile README/limits and completion evidence.
- [ ] Publish a focused PR, verify CI, merge only passing changes within user-authorized issue resolution; close issues only with their acceptance evidence. Document any remaining external dependency in the issue instead of claiming completion.

## Constraints

No unrelated public service deployment or paid usage. No automatic notifications to clients. Source documents remain untrusted. OCR models/tools must be explicitly installed by the operator. Enterprise tenant access, licensed research and blinded Legora comparison remain externally dependent; this issue batch does not invent their completion.

## Progress

26 October: open issues read directly from GitHub. Local main is clean. User asked for fixes and GitHub resolution. Server/domain requested while independent work proceeds.

27 October: archive failure rollback and pre-upload owner regression pass. Local suite: 198 passed, two real-engine tests skipped; production build, synthetic benchmark, dependency audit and Windows newline-aware formatting passed. Whole-change review found no critical/important defects; parsing deadline documentation corrected. Linux Verify run 40462755052 passed real Tesseract/Poppler extraction and actual HTTP matter upload/search acceptance. PR #8 published; final CI/merge pending. Issue #6 guide and verifier implemented, public hostname/browser acceptance remains blocked on a server/domain.
