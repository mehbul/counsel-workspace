# Launch copy

Use these drafts as starting points. Check each community's rules before posting,
disclose that you maintain the project, and do not coordinate votes or fake
engagement.

## Show HN

**Title:** Show HN: Counsel – a free, self-hosted legal workspace (Apache 2.0)

**Body:**

I built Counsel because legal-AI tooling is priced for large firms, while a lot
of solo lawyers, small teams, and legal-aid groups cannot justify another
per-seat subscription. It is a self-hosted workspace for contract review, legal
research, drafting, workflows, and client collaboration.

What is actually implemented:

- matters, document import, original-file retention, and scoped search;
- clause anchors, review tables, comparisons, and DOCX revisions;
- drafts, comments, checkpoints, workflows, approvals, and schedules;
- a guest-only client portal with explicit publication and revocation;
- Federal Register research and publication watches;
- signed webhook, Slack, and Teams notifications;
- checksummed matter archives with an offline verifier;
- MCP integration so Codex, Claude Code, or another assistant can use it;
- optional local Ollama or bring-your-own model generation, off by default.

It runs in personal mode on one computer, or as a team server with Docker. The
license is Apache 2.0. No hosted service, telemetry, or mandatory API key.

What it is not: there is no OCR, SSO/MFA, iManage/NetDocuments sync, archive
import, or independent security audit. The clause engine has a modest
document-disjoint CUAD validation score. It is not legal advice, and I am not
claiming it is equivalent to Legora or any commercial product.

I would value feedback on the self-hosting path, the authorization model, and
which missing integration would make it useful to a small practice.

Repo: https://github.com/mehbul/counsel-workspace
Site: https://mehbul.github.io/counsel-workspace/

## r/selfhosted

**Title:** Counsel – a free, self-hosted legal workspace for small teams (Apache 2.0)

**Body:**

I wanted a legal workspace that a small practice can run on its own hardware
without a per-seat legal-AI subscription. Counsel is a Node.js/SQLite app with
matter isolation, document review, drafting, workflows, a client portal,
research watches, notifications, and checksummed matter exports.

Quick start:

```sh
git clone https://github.com/mehbul/counsel-workspace.git
cd counsel-workspace
npm ci
npm run start:personal
```

It opens on `127.0.0.1:3000` with synthetic seed data. For a team, use the
Docker Compose file and follow `docs/OPERATIONS.md`. Model generation is off by
default; you can use local Ollama or configure a provider.

Limits I want to be upfront about: no OCR, no SSO/MFA, no DMS permission sync,
and no independent security audit. Archive restore is owner-only and keeps the
documented side-effect rules: restored jobs never run, schedules and watches
come back disabled, audit rows are not restored. Please read
`SECURITY.md` and `DISCLAIMER.md` before putting client material in it.

I am looking for feedback from people who actually self-host legal or
document-heavy workloads.

## r/legaltech

**Title:** A free, self-hosted legal workspace for small practices (Apache 2.0)

**Body:**

Most legal-AI platforms are sold to firms with enterprise budgets. I am building
a self-hosted alternative for solo lawyers, small teams, and legal aid. It covers
matter-scoped document review, clause extraction, drafting, approvals,
workflows, a client portal, and portable matter exports.

It is deliberately honest about scope: the clause engine is measured on a small
document-disjoint CUAD split, the retrieval benchmark is synthetic, and there is
no blinded comparison with commercial products. It is not legal advice. The
source and tests are public so reviewers can challenge the claims.

I would especially appreciate feedback on the review-table workflow and on what
would make the tool trustworthy enough for a small practice.

## Product Hunt

**Tagline:** A free, self-hosted legal workspace. No per-seat legal-AI tax.

**Description:** Counsel is an Apache-2.0 legal workspace for contract review,
research, drafting, workflows, and client collaboration. Run it on your own
computer or server, connect a local or bring-your-own model, and keep your
matter data under your control. No hosted service and no mandatory API key.

**First comment:** I built this for people who cannot justify enterprise legal-AI
pricing. It is a 0.1 release: useful, tested, and honest about the missing
pieces (OCR, SSO, DMS sync, independent audit). Feedback and contributions are
welcome.

## X / LinkedIn

I built a free, self-hosted legal workspace for people who cannot pay enterprise
legal-AI prices.

Matters, contract review, research, drafting, workflows, client portal, and
checksummed exports. Apache 2.0. No hosted service, no telemetry, no mandatory
model API.

It is 0.1, not a Legora replacement claim. Try it, break it, tell me what is
missing.

https://github.com/mehbul/counsel-workspace

## awesome-selfhosted pull request

**Entry:** Counsel workspace — A self-hosted legal workspace for contract
review, research, drafting, workflows, and client collaboration. Apache-2.0,
Node.js/SQLite, Docker. (`Source Code` link, `Demo` link if a safe demo exists.)

Before submitting, confirm the list's current entry format, license requirement,
and whether it accepts a project with no public demo. Do not submit to lists
that require an OSI license unless the project meets their criteria.

## Directory blurb

Counsel is a free, self-hosted legal workspace under the Apache License 2.0. It
combines matter isolation, document review, clause extraction, comparisons,
drafting, workflows, a guest portal, research watches, notifications, MCP
integration, and checksummed matter exports. No subscription, hosted service,
telemetry, or mandatory model API. A 0.1 project with documented limits.
