# Public release checklist

This checklist separates what is verified from what remains external. Do not
describe the project as production-certified, independently audited, legally
accurate, or equivalent to a commercial product.

## Repository and licensing

- [x] Apache License 2.0 in `LICENSE`.
- [x] `NOTICE` and `THIRD-PARTY-NOTICES.md`.
- [x] Internal Legora reconstruction dossier removed from the public history.
- [x] Full-history secret scan with Gitleaks and a documented test-fixture
      allowlist.
- [x] Old development history preserved in a private archive repository.
- [x] Confirm the repository contains no client data, internal credentials, or
      private filesystem paths. Commit metadata uses the maintainer's existing
      public GitHub identity.
- [ ] Confirm trademark and naming review for the project name and any
      comparative references.
- [ ] Confirm every dependency license is compatible with Apache 2.0
      distribution. The production inventory is currently permissive; this is
      not a legal opinion.

## Community and security

- [x] `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
      `PRIVACY.md`, `DISCLAIMER.md`, `CHANGELOG.md`, and `NOTICE`.
- [x] Issue templates and pull-request template.
- [x] Dependabot configuration.
- [x] Enable GitHub private vulnerability reporting.
- [x] Enable GitHub Discussions or document that issues are the support channel.
- [x] Enable secret scanning, push protection and Dependabot security updates.
- [ ] Add `good first issue` and `help wanted` labels and seed a few scoped
      issues.
- [ ] Confirm the Code of Conduct contact route works without exposing personal
      data.

## Verification

- [x] `npm test` passes locally.
- [x] `npm run build`, `npm run format:check`, `npm run benchmark`, and
      `npm audit --omit=dev --audit-level=high` pass locally.
- [x] Matter-archive verifier passes against generated metadata, full, and
      empty-matter archives.
- [x] Headless browser download accepted by the verifier.
- [x] GitHub CI passes on the public repository.
- [x] CodeQL analysis completes without unresolved high-severity findings. All
      four high-severity findings were fixed in code; the `test` directory is
      excluded from analysis and five remaining medium findings were dismissed
      as false positives with written justifications (see
      `docs/VERIFICATION.md`).
- [ ] Dependency-review workflow runs on a pull request.
- [x] Release workflow publishes a container image to GHCR.
- [x] GitHub Pages deployment succeeds and the landing page is reachable.

## Release and discoverability

- [x] Tag `v0.1.0` and publish release notes.
- [x] Set the repository description, homepage, and topics.
- [x] Confirm the README renders correctly on GitHub, including screenshots and
      badges.
- [ ] Submit the sitemap to Google Search Console after verifying ownership.
- [ ] Submit to appropriate self-hosted, legal-tech, MCP, and privacy
      directories only where the license and project scope fit.
- [ ] Publish one honest launch post in a relevant community; do not use fake
      accounts, fake stars, or astroturfing.
- [ ] Record baseline traffic, stars, forks, and issues; review referrers after
      two weeks.

## External review still missing

- [ ] Independent security assessment or penetration test.
- [ ] Legal review of the disclaimer, privacy statement, trademark references,
      and non-legal-advice positioning.
- [ ] Blinded legal-quality comparison with any commercial product.
- [ ] Real Slack, Teams, Google, Microsoft, iManage, or NetDocuments tenant
      acceptance.
- [ ] Production HTTPS deployment, load test, and restore drill by an operator.

## Claims to avoid

- "Legora-equivalent", "better than Legora", or any unblinded superiority claim.
- "Legally accurate", "court-ready", or "replaces a lawyer".
- "Production-ready", "enterprise-grade", or "secure" without qualification.
- "Works with every DMS" or "full Office integration" beyond the tested scope.
- Invented benchmarks, ratings, customer counts, or testimonials.
