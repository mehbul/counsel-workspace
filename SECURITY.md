# Security policy

## Supported versions

| Version        | Supported |
| -------------- | --------- |
| `0.1.x`        | Yes       |
| Older versions | No        |

This is a `0.x` project. Security fixes are made on `main` and in the latest
release. There is no long-term-support branch yet.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting:

<https://github.com/mehbul/counsel-workspace/security/advisories/new>

Include:

- the affected version or commit;
- the deployment mode (personal, team, or Docker);
- a minimal reproduction or proof of concept;
- the impact you believe is possible;
- relevant logs with secrets, cookies, document text, and personal data removed.

You will receive an acknowledgement on a best-effort basis, normally within
72 hours. The maintainer will triage the report, agree on a disclosure timeline,
and credit you if you want credit. Please allow up to 90 days for a coordinated
fix before publishing details.

There is no bug bounty. This is a volunteer, self-hosted project.

## In scope

Reports are especially useful for:

- authentication or session bypass;
- cross-workspace or cross-matter access;
- privilege escalation between owner, editor, viewer, and guest roles;
- CSRF, origin-check, or WebSocket authorization failures;
- server-side request forgery through webhooks, connectors, or research fetches;
- path traversal, unsafe ZIP handling, or archive checksum bypass;
- injection into SQL, HTML, DOCX, or generated files;
- exposure of connector credentials, notification secrets, MCP keys, or session
  tokens;
- failures to revoke access after a role, grant, session, or account change;
- tampering with a matter archive that the offline verifier accepts.

## Out of scope

- legal accuracy, hallucinated analysis, or the quality of a model's answer;
- prompt injection that does not cross an authorization or data boundary;
- missing enterprise features such as SSO, SCIM, MFA, or DMS permission sync;
- a deliberately misconfigured self-hosted deployment, including public
  exposure without TLS, weak owner passwords, or an unauthenticated model server;
- reports that only identify an outdated dependency without a demonstrated
  exploit path (these are still welcome as normal issues);
- social engineering, physical access, or denial of service that requires
  unbounded resources;
- the absence of encryption or signatures on exported archives (documented
  behavior, not a vulnerability).

## Security model and residual risk

Counsel workspace is a single-instance, self-hosted application. The operator is
responsible for the host, TLS, network exposure, backups, operating-system
patches, and account administration.

Implemented boundaries include Argon2 password hashing, revocable sessions,
CSRF and origin checks, rate limits, workspace and matter authorization,
owner/editor/viewer/guest separation, encrypted connector and notification
secrets, SSRF-resistant outbound requests, upload parsing limits, and a
dependency-free ZIP reader with path, duplicate, encryption, symlink, and
checksum checks.

The project does **not** currently provide:

- an independent security audit or penetration test;
- MFA, SSO, SCIM, or enterprise directory integration;
- encryption of the SQLite database or uploaded originals at rest;
- encryption, signing, or notarization of exported matter archives;
- multi-instance or high-availability operation;
- a guarantee that optional model providers keep data confidential.

Matter archives can contain privileged client material, source text, internal
identifiers, and audit records. Store and transfer them under the applicable
confidentiality and data-protection rules.

## Safe harbor

Good-faith research is welcome. Test only against an instance you control, use
synthetic data, do not access another person's data, do not run destructive or
high-volume tests, and give the maintainer a reasonable opportunity to fix the
issue before disclosure. The project will not pursue legal action for
good-faith research that follows these rules.
