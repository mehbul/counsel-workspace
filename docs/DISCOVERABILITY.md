# Search and agent discoverability

The public site is a static, self-contained landing page and documentation index.
It describes the actual self-hosted workflow, not an aspirational product.
Claims must stay traceable to the repository, tests, or published measurements.

Canonical URL: `https://mehbul.github.io/counsel-workspace/`

## What is included

- A static landing page with a meaningful title and description, canonical URL,
  visible content without JavaScript, accessible headings, screenshots, feature
  explanations, installation steps, FAQs, and links to the real guides.
- Open Graph and Twitter preview metadata.
- JSON-LD `SoftwareApplication` describing the project, source repository,
  Apache 2.0 license, zero price, operating systems, requirements, and feature
  list. It contains no fabricated reviews or ratings.
- A sitemap for the canonical page and a permissive `robots.txt` template.
- `llms.txt` as a factual documentation index and `product.json` as a
  machine-readable capability and limitation file.
- A Pages workflow that publishes only the `site/` directory. It never publishes
  local databases, uploaded documents, backups, logs, or environment files.

## GitHub metadata

Description (as set on 26 October 2026):

> Free, self-hosted, Apache-2.0 legal workspace for contract review, research,
> drafting and matter collaboration. An independent, open alternative to
> Legora.

Topics (20, as set):

`access-to-justice`, `apache-license`, `artificial-intelligence`,
`contract-review`, `contracts`, `law-firms`, `legal-ai`, `legal-aid`,
`legal-research`, `legal-software`, `legal-workspace`, `legaltech`, `llm`,
`mcp`, `nodejs`, `open-source`, `self-hosted`, `sqlite`,
`legora-alternative`, `solo-lawyers`

README keywords to keep visible: free, self-hosted, open source, legal
workspace, contract review, legal research, drafting, matter management, MCP,
local AI, no subscription, Apache 2.0, Legora alternative.

## Content plan

1. **Landing page** — what it is, who it is for, what is free, what is not
   included, and how to run it.
2. **Quickstart** — personal mode in three commands; Docker for a team.
3. **Workflow pages** — contract review, research, drafting, workflows, client
   portal, and matter archives, each linked to the relevant document.
4. **Comparison page** — a factual "if you are comparing with Legora" section.
   State the commercial product's strengths and this project's limits. Do not
   claim superiority without a blinded comparison.
5. **Trust page** — security model, threat model, verification, secret scan,
   archive verifier, and the missing independent audit.
6. **FAQ** — cost, hosting, model providers, data location, accuracy, backups,
   export, and licensing.

## Launch channels

Use channels where the project's honest scope fits. Read each community's rules
first; some ban self-promotion or require a maintainer flair.

- GitHub topics, description, release, and Pages site (the durable baseline).
- `r/selfhosted` and `r/legaltech` (only if the rules allow project posts).
- Hacker News `Show HN`.
- Product Hunt.
- `awesome-selfhosted`, `awesome-legal-tech`, `awesome-mcp-servers`, and similar
  lists, only where the license and scope meet their criteria.
- Privacy and local-AI communities.
- A short post on the maintainer's own site or social account.

Do not buy stars, use fake accounts, astroturf, or ask people to star without
using the project. Those tactics damage trust and can violate platform rules.

## Measurement

- GitHub traffic: views, unique visitors, referrers, and popular paths.
- Google Search Console after verifying the Pages URL and submitting the
  sitemap.
- Stars, forks, issues, and pull requests as community signals, not product
  quality proof.
- Referrers from search, GitHub, AI assistants, and launch posts.
- Review the baseline after two weeks and update the content that actually
  brings qualified visitors.

### Recorded baseline

Recorded on 26 October 2026, the public launch day, so future changes are
measured against something concrete. These numbers say nothing about product
quality and are not used as marketing claims.

- Stars: 0. Forks: 0. Watchers/subscribers: 0. Open issues: 3 (the seeded
  scoped issues); 1 pull request merged (`#3`).
- Repository traffic (14-day window starts at zero): views 0, unique visitors
  0, clones 0, referrers none, popular paths none.
- Search Console, directory submissions, and launch posts have not been
  submitted yet; they require the maintainer's own accounts and verification.

## Maintenance

1. Keep commands, features, limits, and license statements aligned across
   `README.md`, `site/`, `site/llms.txt`, and `site/product.json`.
2. Update the documentation date only when substantive content changes.
3. Recheck canonical URLs and relative assets after changing hosting paths.
4. Validate structured data and the sitemap on the live page.
5. Keep the Pages allowlist restricted to `site/`.
6. Never add invented ratings, customer logos, or performance claims.

## GitHub Pages notes

A project site lives under `/counsel-workspace/`. A `robots.txt` inside the
project path is not authoritative for the whole `mehbul.github.io` origin;
crawlers read the origin-root file. The project file is a portable template, not
a claim that it controls the whole origin. Manage the origin-root file in the
user-site repository if needed.
