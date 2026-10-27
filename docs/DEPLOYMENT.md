# HTTPS deployment

This is a single-host deployment recipe. No public hostname or server was supplied for this release, so certificate issuance and public deployment have not been verified. Run the checks below on your host before using confidential documents.

## Host and configuration

Use Docker Engine with Compose v2 on a patched Linux host with encrypted local storage, DNS pointing directly to the host, and inbound TCP 80 and 443. The app has a 1 GiB memory limit and two CPUs; measure your own workload. Keep port 3000 private. SQLite supports one app replica on the local named volume, not a shared filesystem.

Copy `.env.example` to `.env`, restrict its permissions (`chmod 600 .env`), and replace `DOMAIN` with a bare hostname such as `counsel.your-company.example` (no scheme or path). Keep `.env` out of source control and backups shared publicly. Compose sets `APP_ORIGIN=https://${DOMAIN}`, `COOKIE_SECURE=true`, and `TRUST_PROXY=1`. Provider keys in `.env` are optional; `AI_PROVIDER=evidence` is the default. Saved provider profiles use the separate encrypted database settings and require the model key during recovery.

For optional local OCR, set both `INSTALL_OCR=1` (image build) and `COUNSEL_OCR_ENABLED=1` (runtime), then rebuild. English is the supplied language; additional Tesseract language packs need a custom image. OCR uses the 128 MiB temporary filesystem and still needs representative staging tests. See [OCR.md](OCR.md).

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 proxy
node scripts/verify-deployment.js https://YOUR_HOSTNAME
```

Review full `docker compose config` only locally: its output can expose secrets. Keep both Caddy volumes, which hold certificate/account state. Caddy automatically obtains and renews certificates and redirects HTTP to HTTPS. DNS, reachable ports and CA issuance must actually succeed; a running container is not proof of trusted TLS. Pin reviewed image digests in your release process.

## Proxy behavior and acceptance

Caddy forwards ordinary HTTP and WebSocket upgrades to `app:3000`. No separate WebSocket port is needed. The request-body cap is 257 MiB to allow a 256 MiB matter archive plus multipart overhead; application route limits still apply (ordinary imports: five files, 20 MiB each). Do not introduce shorter upstream timeouts without testing imports and model generation.

The app trusts exactly one proxy hop. With this topology Caddy is that hop; Caddy replaces untrusted incoming forwarded client-address headers. Do not publish the app port or attach untrusted containers to its private network. Adding a CDN, load balancer or another proxy changes the trust boundary and requires a separately reviewed forwarded-header configuration. Rate limits depend on correct client IPs.

The verifier checks trusted TLS through Node's normal certificate validation, HTTP redirect, readiness/liveness, security headers and anonymous API denial. It does not create users, upload documents, test WebSockets or prove authorization for signed-in accounts. A failure is not bypassed with `NODE_TLS_REJECT_UNAUTHORIZED=0` or insecure curl flags.

After it passes:

1. Read `docker compose exec app cat /data/bootstrap-token` privately and create the owner at your HTTPS origin. Setup consumes the token. Confirm the session cookie is Secure, HttpOnly and SameSite Strict in browser developer tools.
2. Create editor and viewer accounts. Test matter grant/revoke, logout, disabled accounts, and cross-origin mutation rejection in separate browsers.
3. Open the same draft in two signed-in browsers; confirm a WebSocket status 101 and edits arriving in both directions. Reconnect after restarting the app.
4. Upload representative PDF/DOCX and optional scans; export and restore a test archive; confirm oversized bodies fail safely. Check request latency and memory under your expected concurrency.
5. Verify client-address-based limits with two independent clients and a forged `X-Forwarded-For` header. The forged header must not bypass the limit or become the trusted client identity.
6. Perform the backup and isolated restore drill in [OPERATIONS.md](OPERATIONS.md), then record the hostname, date, image revision, results and outstanding failures. Public TLS acceptance remains incomplete until these checks run against the actual hostname.

## Recovery essentials

The database alone is not a complete recovery set. Preserve `workspace.db` via the online backup script, `integration-key` (connector and notification credentials), `model-key` (saved model profiles, when present), deployment configuration and Caddy certificate volumes. Never substitute newly generated keys for missing originals. Follow [OPERATIONS.md](OPERATIONS.md) for a read-only restore check and isolated recovery before replacing a live database.
