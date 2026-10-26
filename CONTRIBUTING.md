# Contributing

Thanks for helping make a free, self-hosted legal workspace useful to people who
cannot pay enterprise legal-AI prices. Contributions of code, tests,
documentation, accessibility fixes, and careful bug reports are welcome.

By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Requirements:

- Node.js 24.15 or newer
- npm 11 or newer
- Git

```sh
git clone https://github.com/mehbul/counsel-workspace.git
cd counsel-workspace
npm ci
npm run start:personal
```

Personal mode opens at <http://127.0.0.1:3000> with synthetic seed data. For a
team-mode instance, follow [deployment and operations](docs/OPERATIONS.md).

## Before opening a pull request

Run:

```sh
npm test
npm run build
npm run benchmark
npm run format:check
```

If you changed archive code, also run:

```sh
npm run verify:archive -- path/to/archive.zip
```

On Windows with `core.autocrlf=true`, use Prettier's auto line-ending mode
locally so unchanged files do not show up as modified:

```sh
npx prettier --check --end-of-line auto server.js test public/app.js
```

CI checks LF endings on Linux. Do not run a repository-wide Prettier `--write`
on a Windows checkout; it creates broad line-ending diffs.

## Tests

- Every authorization change needs a positive and a negative test.
- Every parser, archive, connector, or webhook change needs a malformed-input
  test.
- Tests must use isolated in-memory databases and temporary data directories.
- Do not call real Slack, Teams, model providers, or the public internet from
  the default suite.
- Do not commit client documents, real credentials, or downloaded datasets.
- New runtime dependencies need a clear reason; prefer the standard library.

## Architecture map

| Area                                               | Files                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| HTTP server and route wiring                       | `server.js`                                                       |
| Authentication, sessions, CSRF, rate limits, audit | `security.js`                                                     |
| Matters, documents, review tables, comparisons     | `retrieval.js`, `evidence.js`, `comparisons.js`                   |
| Drafting and DOCX export                           | `drafting.js`, `redlines.js`, `rich-text.js`                      |
| Workflows, approvals, schedules                    | `workflows.js`, `workflow-schedules.js`                           |
| Client portal                                      | `portal.js`                                                       |
| Research and publication watches                   | `research.js`, `legal-sources.js`, `ecfr-source.js`               |
| Notifications and signed delivery                  | `notifications.js`, `secret-box.js`                               |
| Matter archives                                    | `matter-archive.js`, `zip.js`, `scripts/verify-matter-archive.js` |
| MCP host integration                               | `mcp/`, `agent-api.js`, `agent-contract.js`                       |
| Browser app                                        | `public/`, `client/`                                              |
| Tests                                              | `test/`                                                           |

## Pull requests

Keep a pull request focused. Explain:

1. the user problem;
2. the behavior you changed;
3. the security and access-control impact;
4. the tests you added or updated;
5. any remaining limitation.

Update the relevant document when behavior, limits, or claims change. Do not
describe a prototype, a synthetic benchmark, or a local test as an enterprise
integration, a legal-accuracy result, or a Legora comparison.

## Developer Certificate of Origin

Contributions are accepted under the Apache License 2.0. Sign off every commit
to certify that you wrote the change or have the right to submit it:

```sh
git commit -s -m "Describe the change"
```

The sign-off adds a `Signed-off-by` line using your Git name and email. See the
[Developer Certificate of Origin 1.1](https://developercertificate.org/).

## Security and sensitive data

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Never put real client material, privileged documents, access tokens, or
personal data in an issue, test fixture, screenshot, or pull request.

## Legal and accuracy boundaries

This project is not a law firm and does not provide legal advice. Do not add
claims that the software is legally accurate, production-certified, or
equivalent to a commercial product without evidence that can be independently
reviewed. The [disclaimer](DISCLAIMER.md) applies to contributions and releases.
