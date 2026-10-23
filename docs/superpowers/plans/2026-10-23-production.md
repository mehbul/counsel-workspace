# Self-hosted Counsel hardening plan

Goal: move the anonymous local prototype toward a deployable authenticated single-instance service. Production parity with Legora is a separate, unproven objective.

Architecture: SQLite WAL on a persistent local volume; per-workspace request context and serialized mutations; local Argon2 accounts and revocable opaque sessions; TLS termination at a reverse proxy. No public signup. Initial owner requires a locally provisioned setup token; owners provision workspace members. One application replica only.

- [x] Add failing integration coverage for anonymous access, origin checking, role restrictions, session revocation and workspace isolation.
- [x] Introduce security.js: schema migrations, setup, sessions, account management, authorization, input validation and audit records.
- [x] Replace global data access with request-local workspace state. Serialize requests per workspace and load the latest persisted state each time.
- [x] Add authenticated UI, workspace identity, member administration and password change/logout.
- [x] Bound uploads, model calls and output; add idempotency/concurrency safeguards, immutable audit and health checks.
- [x] Package non-root Docker deployment, TLS proxy example, backup/restore utilities, CI and operating instructions.
- [x] Run regression/security tests and browser checks. Record residual blockers without claiming full production certification.

User selected self-hosted Docker and local accounts initially. Existing data must be preserved and explicitly claimed by the initial owner. Test state must remain isolated from user data. Never place setup/session secrets into public files or logs.

Release gates remain open: Docker build and TLS deployment unavailable on this host; provider adapters have mock-provider tests but need live tenant verification. Plain-text collaboration and two document snapshot adapters are implemented; full Legora parity remains incomplete.
