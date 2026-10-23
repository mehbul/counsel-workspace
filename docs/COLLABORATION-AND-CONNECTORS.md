# Collaboration and enterprise document connections

## What is implemented

Draft bodies support simultaneous **rich-text** editing through Yjs over authenticated WebSockets. Changes merge, persist in SQLite and appear in other connected clients. The editor displays connection/save status and a count of connected people. Reconnection resends unacknowledged updates. Read-only users receive the shared draft but cannot submit updates. Matter grants and session validity are checked on connection, on messages, before broadcasting updates, and periodically for idle connections.

The server stores the CRDT state and the materialized draft text in one transaction, so Word export uses the persisted shared content. Wait for **All changes saved** before exporting or navigating away. Draft titles are separate explicit saves; titles are not collaboratively merged. The editor supports headings, emphasis, lists, alignment, and per-client collaborative undo/redo. Whole-draft comments can be resolved or reopened. Named checkpoints preserve rich text and can be restored for everyone, saving a Before restore checkpoint first. DOCX exports retain supported formatting. Tracked changes, anchored comment ranges and selection/cursor sharing are not implemented.

The deployment remains **one application instance**. WebSocket rooms live in that process; multiple replicas require a shared update distribution layer. The existing Caddy reverse proxy supports WebSocket upgrades. State updates are bounded, and oversized/rejected updates close the connection. A draft reaching its CRDT-history limit needs an explicit archival/compaction workflow, which is not yet implemented.

## Microsoft 365 / SharePoint

Owners open **Integrations → Connect a folder → Microsoft 365 / SharePoint**, then supply organization-approved Entra tenant ID, application client ID and secret, Graph drive ID, folder item ID (or `root`), and destination matter. Token acquisition uses the official client-credentials endpoint and Graph `.default` scope. The app does not create an app registration or grant tenant consent.

Have your tenant administrator restrict the application to intended sites using suitable Microsoft permissions. Import requires read access. Export additionally requires write access. Validate your chosen least-privilege configuration in a test tenant; this application has not been tested with live tenant credentials.

Sync follows paginated folder listings and optionally traverses subfolders, importing supported binary files. Graph content download redirects are followed only to HTTPS SharePoint/OneDrive hostnames, without forwarding Graph bearer credentials to those download hosts. New imports have source identifiers and versions. Repeat sync skips unchanged files. Changed files produce new local document versions, retaining earlier citation targets. New analysis excludes superseded versions.

Draft export is an explicit owner action that creates a DOCX in the configured folder. It is not a tracked-change merge or a source-file replacement. The Microsoft upload includes conflict-failure conditions; verify collision behavior in your target drive before production use.

## Google Drive

Owners supply their approved OAuth client ID, client secret, refresh token, folder ID and destination matter. Obtain the refresh token through the organization's consent process outside this app. The connector refreshes access through Google's token endpoint and uses Drive API file listing/download and multipart upload. Import supports PDF, DOCX and text files and exports native Google Docs to DOCX for extraction. Sheets and Slides are not supported. Shared-drive-specific behavior has not been verified.

Export creates a new DOCX file in the configured folder. Google Drive permits duplicate filenames; this action does not overwrite existing items.

## Access policy — important distinction

These connectors implement **owner-authorized snapshot import**, not a permissions-preserving DMS mirror. The selected matter's grants govern all imported content. Source-system per-file ACLs, ethical walls, deletes, moves, permission revocations and retention policies are **not automatically synchronized**. The UI warns owners before import. Do not connect a folder where this policy would expose information to inappropriate matter members.

Each sync follows pagination with a budget of 64 pages, 50 folders and 1,000 files. Reaching a budget returns an explicit partial result; it does not provide a durable continuation cursor. Optional recursive traversal deduplicates folders and files. There is no scheduled polling, delta-feed subscription or webhook handling. This scope must not be presented as complete enterprise DMS synchronization. iManage, NetDocuments, Teams, Slack, Outlook and Office add-ins are not implemented.

## Credentials, backups and operations

Connector credentials are encrypted using AES-256-GCM with a randomly generated server key at `DATA_DIR/integration-key`. API lists never return secrets. **Back up this key separately and securely along with the database.** A SQLite backup without the key cannot decrypt connector credentials after restoration. Database content and collaboration text themselves still require encrypted host storage. Disconnect removes the credential record but leaves imported documents and their citations intact.

Sync uses the existing durable job queue. It can be resumed/replayed after process restart; imported versions are deduplicated through persisted remote-version mapping. The job retains safe failure status rather than logging provider tokens. External provider operations have deadlines and bounded response sizes. Read/token requests retry 429 and 503 responses up to three times with bounded Retry-After/exponential delays. Writes are not automatically retried. Delays over 30 seconds fail for later explicit retry. Large imports can hold the workspace serialization lock for an extended period.

## Verification performed

- API security/regression tests for accounts, roles, workspace and matter access, sessions, CSRF, file import, reviews, exports and backup integrity.
- Real WebSocket tests with two Yjs clients: concurrent updates converge; text and formatting persist; DOCX retains emphasis; checkpoint restoration reaches both clients; reconnect loads saved state; viewer edits fail; invalid origins and revoked matter grants cannot connect.
- Mock-provider connector tests for Google and Microsoft token acquisition, listing, imports, repeated sync, changed-version retention, secret redaction/encryption, safe Graph download redirect, explicit DOCX upload, owner-only operations, pagination, traversal limits, native Google Docs extraction and rate-limit retry.
- Browser checks of the restored navigation, shared editor autosave, two-tab content/presence and connector setup form.

**Not verified:** live Microsoft/Google credentials, provider consent/ACL policies, live file writeback, live TLS deployment, multi-replica scaling, legal research accuracy, or full Legora equivalence.

## Primary implementation references

- [Yjs document updates](https://docs.yjs.dev/api/document-updates)
- [Microsoft Graph file download](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0)
- [Microsoft Graph upload content](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0)

These document public protocols. They do not establish Legora's private implementation.
