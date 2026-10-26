# Privacy

Counsel workspace is self-hosted software. The project does not operate a hosted
service, does not include telemetry or analytics, and does not send usage data to
the maintainer. The person or organization running an instance is the operator
and decides what data is stored, who can access it, and where it is hosted.

## Data the application stores

Depending on how you use it, an instance stores:

- account names, email addresses, password hashes, roles, and sessions;
- matters, documents, extracted text, retained original files, page and paragraph
  anchors, and source metadata;
- review tables, findings, comparisons, drafts, comments, checkpoints, tasks,
  workflows, approvals, schedules, and audit records;
- connector credentials and notification secrets, encrypted with the instance
  key;
- portal publications and guest recipient records;
- MCP access keys, their scopes, and their expiry and revocation state;
- operational records such as job state, notification receipts, and server logs.

The SQLite database and uploaded files are not encrypted at rest by the
application. Use full-disk encryption, restricted filesystem permissions, and
encrypted backups if that matters for your matter.

## Optional outbound connections

The application makes no model call unless you configure a provider. If you do,
the question and retrieved passages are sent to that provider. A local Ollama
instance keeps the request on your network; a cloud provider receives the data
under its own terms.

Other optional outbound connections include:

- the US Federal Register and eCFR for research and publication watches;
- Google Drive, Microsoft Graph, or another configured connector;
- webhooks, Slack, or Microsoft Teams for notifications;
- an MCP client or assistant that you connect to the instance.

Each destination receives only the data required for the feature you enabled.
Review the destination's privacy and confidentiality terms before sending
client material.

## Browser storage

The browser uses cookies for the session and CSRF token. It may store interface
preferences locally. It does not load third-party analytics or advertising
scripts. The public landing page is static and self-contained.

## Logs and retention

Application logs may contain request metadata such as timestamps, routes, status
codes, and client addresses. Do not enable verbose logging of document text or
credentials. Retention, deletion, and backup policies are controlled by the
operator. Deleting a record in the application does not necessarily delete it
from existing backups.

## Contact

For a privacy question about this repository or the public landing page, open a
minimal GitHub issue that does not contain personal or client data. For a
security issue, use the private process in [SECURITY.md](SECURITY.md).
