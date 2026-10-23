# Self-hosted deployment and operations

## Current release status

This release adds a deployable single-instance foundation; it is not independently certified as production-ready or equivalent to Legora. Local security and regression tests pass. GitHub CI verified the Docker image build, startup under a read-only filesystem, readiness response and anonymous API rejection. TLS issuance, realistic resource/load limits and reverse-proxy behavior still require staging verification. Do not treat the configuration files as proof of a successful deployment.

## Deployment

Requirements: Docker Engine with Compose v2, a Linux host with encrypted persistent storage, a domain pointing to that host, inbound ports 80 and 443, and enough memory for the application (1 GiB container allowance). Use a supported and patched host. This configuration runs one app replica against a local SQLite volume; do not use network filesystems or scale replicas.

1. Copy `.env.example` to `.env` and set `DOMAIN` to your real hostname. Never commit `.env`. If generated assistance is needed, configure `OPENAI_API_KEY`; only then are retrieved passages transmitted to OpenAI. Organization approval and provider terms must cover the intended documents.
2. Run `docker compose config` and review the resolved topology locally (it may display environment secrets; do not share its output).
3. Run `docker compose up --build -d`. The app runs as the non-root `node` user. Only Caddy publishes ports. Caddy handles TLS; the app requires secure cookies and a configured HTTPS origin in production.
4. Read the one-use setup token locally with `docker compose exec app cat /data/bootstrap-token`. Treat it as a secret. Open your HTTPS hostname and create the owner account with that token. Setup removes the token and transfers the old prototype state, if any, to the owner's workspace. There is no public signup or default password.
5. Open Account → Manage members to create editor/viewer accounts. Use a private channel for initial passwords; members should change them immediately. Open Account → Matter access to explicitly assign matters. Owners can access all matters; editors automatically receive access to matters they create. Other matters are hidden until granted.
6. Verify the staging checklist below before importing confidential data.

To migrate an existing prototype installation, stop it first. Make a verified backup of `data/workspace.db`. Copy the database and any associated WAL state via the SQLite backup utility, not an arbitrary live-file copy, into the persistent Docker volume before initial setup. Keep the original directory until migration and restoration have been verified. No migration runs against a cloud service.

## Authentication and authorization

Local passwords use Argon2id. Session cookies are HTTP-only, SameSite Strict, secure under production configuration, and expire after eight hours. Session secrets are stored hashed in SQLite. Logout, password change and disabling an account revoke sessions. Mutation requests require a session CSRF token; cross-origin browser mutations are rejected. Sign-in attempts and API traffic are rate-limited in this one process; a multi-replica deployment would require shared limits.

Workspace and matter authorization apply to state reads, document imports/searches, citations, reviews, drafts, exports and tasks. Revoking access prevents future API reads, but cannot erase material a user already downloaded or retained in an open browser tab. Skill instructions are workspace-wide and visible to workspace members. Activity history with document titles is owner-only; audit records are owner-only and not editable through the API.

Owners are trusted administrators with access to every matter. If your policy requires administrators to be blind to some matters, this authorization model needs redesign before deployment.

## Durable runs

The browser queues draft generation and review extraction as persisted jobs. The worker executes one job at a time. Refreshing the browser recovers its pending run. Process restart returns running jobs to the queue; output IDs are stable so an already persisted draft or review is reused. External model calls can still be repeated if a crash occurs before output persistence, so provider billing is not exactly-once. Failed runs retain a status and safe error; starting a new run is explicit.

Each workspace serializes API work and jobs to avoid lost writes to the JSON workspace record. This is intentionally a modest-scale architecture; a long model call can delay other work in that workspace. There are bounded queues and timeouts, but no distributed scheduler, multi-region failover, or full run-cancellation interface.

Document parsing runs in a separate child process with a 30-second deadline and a 192 MiB V8 heap limit. At most two parse processes run concurrently; uploads allow five files of at most 20 MiB each. These controls bound common failures; a child process is not a security sandbox and its V8 limit is not a complete bound on native memory. The container memory limit and staging malicious-file tests remain necessary. OCR is not included.

## Backup and recovery

Use the Node SQLite online backup API. In Docker:

```sh
docker compose exec app mkdir -p /data/backups
docker compose exec app node scripts/backup.js /data/backups/counsel-2026-10-23.db
```

Choose a fresh filename each time. The script never overwrites an existing path and runs `PRAGMA integrity_check` on the result. Copy backups to encrypted, access-controlled storage on another machine. Backups contain account hashes, session records and document content; protect them like the live database. Set a retention period and periodically restore a backup to a separate staging volume.

Restore procedure: stop the app, preserve a recovery copy of its existing data volume, validate the chosen backup with SQLite integrity checking, replace the stopped database with the backup, and remove only stale WAL/SHM files belonging to that replaced database. Restart, revoke restored sessions, and check users, matter grants, documents, review decisions and exports. Do not run restore against a live process. No destructive restore automation is provided.

Account recovery is an offline host-administrator operation. Stop the app, put the new password in a private file, run `node scripts/reset-password.js user@example.com /private/password-file` with the same `DATA_DIR`, then securely remove the private file and restart. This revokes all sessions for the recovered account. No recovery via unauthenticated web endpoints exists.

## Monitoring and upgrades

`/health/live` reports process reachability. `/health/ready` checks SQLite access. Collect container restart count, health failures, disk space, memory and structured error logs. Error logs contain request IDs and error names, not raw documents or passwords. Audit logs are persistent in the database but are not an independently immutable or tamper-evident archive. Host administrators can alter them. Forward them to your trusted log platform if required.

Before upgrades: verify a recent backup, run CI and dependency audit, build the image in staging, exercise login/roles/grants/import/review/export, then deploy. Pin approved image digests in your release system; the supplied Docker tags are explicit versions but not immutable digests. Rollback is a coordinated app-image and database-backup operation, not just switching an image tag after a schema change.

## Staging release checklist

- Build image and validate Compose; confirm non-root execution and no directly published app port.
- Verify HTTPS, redirects, secure cookies and origin behavior through Caddy.
- Create owner, editor and viewer; prove denied matter access, grant, revoke, logout and disabled-user behavior in separate browsers.
- Import a representative PDF, DOCX and scanned PDF; verify expected unsupported-OCR behavior and malformed-file failures.
- Queue a run, restart the app, verify recovery and no duplicate persisted output; simulate provider outage and invalid credentials.
- Backup and restore to a second volume and compare meaningful application records, including access grants and reviewed cells.
- Run realistic concurrent load tests; measure request latency, queue wait, memory and disk usage against your required workload.
- Obtain independent security review and legal-domain quality review before sensitive client use.

## Remaining gaps relative to the requested goal

The application still does not implement Legora's licensed legal-research sources, legal authority validation, production retrieval quality, OCR, original-document version storage, full Word redlining, rich-text collaborative editing, permissions-preserving DMS synchronization, Office add-ins, monitoring feeds, portals, MFA, SSO, notifications, provider spend quotas or independent compliance certification. SQLite currently stores each workspace as a JSON record, which limits write throughput and increases memory use as workspaces grow. These are substantial engineering workstreams, not configuration switches. This release must not be represented as full Legora parity.

The frontend still uses inline event handlers, so its CSP allows inline scripts. All document and user strings are escaped when rendered, and dynamic identifiers are server-generated UUIDs, but eliminating inline handlers is recommended before treating CSP as a strong injection mitigation.

## Collaboration and connectors update

Plain-text Yjs collaboration and owner-configured Microsoft/Google document adapters are now implemented. See [scope, setup and verification](COLLABORATION-AND-CONNECTORS.md). Back up `DATA_DIR/integration-key` along with the database; credentials cannot be restored without it. These snapshot adapters do not mirror source permissions.
