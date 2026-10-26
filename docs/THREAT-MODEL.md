# Threat model

This is a working threat model for the self-hosted application, not a
certification or a substitute for an independent security review. It describes
what the project tries to protect, where trust changes hands, and what remains
exposed.

## System and deployment

Counsel workspace is a Node.js/Express application with a SQLite database, local
file storage, a browser client, optional WebSocket collaboration, and optional
outbound connections to model providers, research sources, connectors, webhooks,
and an MCP host. It runs as a single instance in personal mode or team mode.

## Assets

- Matter documents, extracted text, retained originals, drafts, review findings,
  comparisons, and client-portal publications.
- Account credentials, sessions, MCP keys, connector credentials, notification
  secrets, and the instance encryption key.
- Audit records and notification receipts.
- Exported matter archives.
- The host, its filesystem, and its network position.

## Trust boundaries

1. Browser to HTTP server.
2. HTTP server to SQLite and the data directory.
3. Server to optional model provider.
4. Server to webhooks, Slack, or Microsoft Teams.
5. Server to research sources and document connectors.
6. MCP client or assistant to the MCP/HTTP API.
7. Container or host to the operator's network.
8. Portal guest to published matter material.

## Actors

- Unauthenticated internet client.
- Authenticated viewer, editor, or guest with limited grants.
- Malicious or compromised workspace owner account.
- Malicious document or archive supplied by a user.
- Compromised dependency or build pipeline.
- Operator or local attacker with filesystem access.
- Third-party service that receives outbound data.

## Threats and mitigations

| Threat                                         | Mitigation                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Credential stuffing or password guessing       | Argon2 hashing, rate limits, generic login errors, revocable sessions, owner-managed accounts.                                         |
| Session theft or fixation                      | HTTP-only cookies, SameSite policy, CSRF tokens, origin checks, session revocation on password/role/account changes.                   |
| Cross-workspace or cross-matter access         | Workspace and matter authorization on every route, job, WebSocket, portal request, export, research call, and MCP tool.                |
| Privilege escalation                           | Explicit owner/editor/viewer/guest capabilities; current grants rechecked before side effects; negative tests.                         |
| CSRF or cross-origin mutation                  | Same-origin enforcement, CSRF tokens, JSON content expectations, origin validation.                                                    |
| SSRF through webhooks, connectors, or research | Scheme and host validation, DNS resolution checks, private/loopback/link-local blocking, redirect refusal, pinned addresses, timeouts. |
| Path traversal or unsafe archive extraction    | Normalized relative paths, duplicate detection, control-character rejection, ZIP reader checks, no extraction by the verifier.         |
| Malicious upload or parser exploit             | File-size limits, MIME/extension checks, bounded parsers, corrupt-file rejection, no shell execution.                                  |
| Secret exposure at rest                        | Connector and notification secrets encrypted with the instance key; secrets excluded from logs and API responses.                      |
| Archive tampering                              | Manifest counts, per-file SHA-256, `SHA256SUMS` coverage, size checks, and an offline verifier.                                        |
| Webhook forgery                                | HMAC signatures over the exact payload, timestamp/replay handling, per-channel secrets.                                                |
| Portal data leak                               | Guest-only role, explicit publication, selected recipients, immediate revocation, internal API and MCP denial.                         |
| Dependency compromise                          | Lockfile, `npm ci`, dependency audit, Dependabot, CodeQL, dependency review on pull requests.                                          |
| Container escape or excessive privilege        | Non-root runtime where supported, read-only filesystem guidance, dropped capabilities, no-new-privileges, memory limit, CI smoke test. |

## Residual risks

- No independent penetration test, threat-model review, or code audit.
- No MFA, SSO, SCIM, or enterprise session policy.
- SQLite and retained originals are not encrypted at rest by the application.
- A compromised owner account can read or delete workspace data.
- Optional cloud model providers receive the passages sent to them.
- Prompt injection can distort an assistant's output; it is not treated as a
  security boundary unless it crosses an authorization or data boundary.
- Exported archives are integrity-checked but not confidential or
  non-repudiable.
- A single instance has no high-availability or tenant-isolation guarantees
  beyond the application's own workspace model.
- Denial of service is possible if an operator exposes the instance without
  rate limits, reverse-proxy limits, or resource constraints.
- Legal output can be wrong even when citations resolve.

## Operator checklist

- Put the instance behind HTTPS and a trusted reverse proxy.
- Bind to loopback or a private network unless public access is intentional.
- Use a strong owner password and unique accounts; disable unused accounts.
- Restrict the data directory and backups to the service account.
- Enable full-disk or volume encryption where confidential material is stored.
- Keep the host, Node.js, and dependencies patched.
- Configure off-host encrypted backups and test a restore.
- Review connector scopes, webhook destinations, and model-provider terms.
- Treat exported archives as confidential matter material.
- Monitor audit records and notification receipts.
