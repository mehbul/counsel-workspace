# HTTPS deployment

This is a single-host deployment recipe. No public hostname or server was supplied for this release, so certificate issuance and public deployment have not been verified. Run the checks below on your host before using confidential documents.

## Host and configuration

Use Docker Engine with Compose v2 on a patched Linux host with encrypted local storage, DNS pointing directly to the host, and inbound TCP 80 and 443. The app has a 1 GiB memory limit and two CPUs; measure your own workload. Keep port 3000 private. SQLite supports one app replica on the local named volume, not a shared filesystem.

Copy `.env.example` to `.env`, restrict its permissions (`chmod 600 .env`), and replace `DOMAIN` with a bare hostname such as `counsel.your-company.example` (no scheme or path). Keep `.env` out of source control and backups shared publicly. Compose sets `APP_ORIGIN=https://${DOMAIN}`, `COOKIE_SECURE=true`, and `TRUST_PROXY=1`. Provider keys in `.env` are optional; `AI_PROVIDER=evidence` is the default. Saved provider profiles use the separate encrypted database settings and require the model key during recovery.

For optional local OCR, set both `INSTALL_OCR=1` (image build) and `COUNSEL_OCR_ENABLED=1` (runtime), then rebuild. English is the supplied language; additional Tesseract language packs need a custom image. OCR uses the 128 MiB temporary filesystem and still needs representative staging tests. See [OCR.md](OCR.md).

### Environment variables

| Variable | Example | Meaning |
|---|---|---|
| `DOMAIN` | `counsel.your-company.example` | Bare hostname without scheme or path. Compose derives `APP_ORIGIN=https://${DOMAIN}` and sets `COOKIE_SECURE=true` and `TRUST_PROXY=1`; do not set those three yourself. |
| `AI_PROVIDER` | `evidence` | Offline default. `ollama` uses the local runtime; `openai` sends selected source passages to that provider, whose terms and approvals must cover the documents. |
| `OPENAI_API_KEY`, `OLLAMA_BASE_URL`, `*_MODEL` | `sk-…`, `http://host.docker.internal:11434`, `gpt-4.1-mini` | Optional provider settings; see `.env.example` comments. |
| `INSTALL_OCR`, `COUNSEL_OCR_ENABLED`, `COUNSEL_OCR_LANGUAGE` | `1`, `1`, `eng` | Optional local OCR build and runtime switches; see [OCR.md](OCR.md). |
| `COUNSEL_IMAGE` | `ghcr.io/mehbul/counsel-workspace:latest` | Optional image override so `up` pulls a released image instead of building; pin a digest for production. |
| `COUNSEL_DB` | `/data/workspace.db` | Database location used by the app and the backup/restore scripts; default is `DATA_DIR/workspace.db` (`DATA_DIR=/data` and `PORT=3000` are baked into the image). Point it at a copy of the data when exercising backups, never at the live file from outside the container. |

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

## nginx alternative

The shipped proxy is Caddy, which CI validates against the real Caddy image. If your environment standardizes on nginx instead, the following reference block mirrors the shipped proxy behavior (TLS termination, one-hop client-IP forwarding, WebSocket upgrades on `/collaboration`, and a body cap above the 256 MiB restore limit). It follows the nginx documentation but has not been executed in this repository's CI; run `nginx -t` on your host before relying on it:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name counsel.your-company.example;

    # Your certificate issuance path, for example certbot:
    ssl_certificate     /etc/letsencrypt/live/counsel.your-company.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/counsel.your-company.example/privkey.pem;

    # Import batches allow five files of 20 MiB each; restores up to 256 MiB.
    client_max_body_size 270m;

    location /collaboration {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}

server {
    listen 80;
    server_name counsel.your-company.example;
    return 301 https://$host$request_uri;
}
```

With a host-level nginx, remove the `proxy` service from compose and publish the app on loopback only, `ports: ["127.0.0.1:3000:3000"]`. Keep `TRUST_PROXY=1`: nginx is now the single trusted hop, and a CDN or another proxy in front of it would again change the trust boundary and mis-key rate limits. Serve `node scripts/verify-deployment.js https://counsel.your-company.example` afterwards; it requires valid TLS, the HTTP redirect and the anonymous denials regardless of which proxy is in front.

## Backup schedule

Schedule the backup script from the host so it runs even when nobody is signed in. Example systemd units (run `systemd-analyze verify` on your host; the node commands inside were exercised against a workspace checkout locally — see the issue tracker for evidence — but these unit files themselves have not been executed here):

`/usr/local/bin/counsel-backup.sh`:

```sh
#!/bin/sh
set -eu
cd /opt/counsel-workspace        # checkout containing compose.yaml and .env
stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p /var/backups/counsel
docker compose exec -T app mkdir -p /data/backups
docker compose exec -T app node scripts/backup.js "/data/backups/counsel-$stamp.db"
docker compose exec -T app node scripts/restore-check.js "/data/backups/counsel-$stamp.db" /data
docker compose cp "app:/data/backups/counsel-$stamp.db" "/var/backups/counsel/counsel-$stamp.db"
```

`/etc/systemd/system/counsel-backup.service`:

```ini
[Unit]
Description=Counsel workspace online database backup

[Service]
Type=oneshot
ExecStart=/usr/local/bin/counsel-backup.sh
```

`/etc/systemd/system/counsel-backup.timer`:

```ini
[Unit]
Description=Nightly Counsel workspace backup

[Timer]
OnCalendar=*-*-* 03:15:00
RandomizedDelaySec=900
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with `chmod +x /usr/local/bin/counsel-backup.sh && systemctl enable --now counsel-backup.timer`, then check `journalctl -u counsel-backup.service` after the first run. A cron equivalent is `15 3 * * * /usr/local/bin/counsel-backup.sh >> /var/log/counsel-backup.log 2>&1`. The timestamped filename is required because the backup script never overwrites an existing path. Copy backups to encrypted, access-controlled storage on another machine (they contain account hashes, sessions and document content), set a retention period, and prune `/data/backups` inside the volume periodically.

## Recovery essentials

The database alone is not a complete recovery set. Preserve `workspace.db` via the online backup script, `integration-key` (connector and notification credentials), `model-key` (saved model profiles, when present), deployment configuration and Caddy certificate volumes. Never substitute newly generated keys for missing originals. Follow [OPERATIONS.md](OPERATIONS.md) for a read-only restore check and isolated recovery before replacing a live database.
