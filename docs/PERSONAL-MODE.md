# Personal use without app login

Run `npm ci` and `npm run start:personal`, then open http://127.0.0.1:3000. The workspace opens directly. No app account, email, password, signup or Legora subscription is required.

The personal launcher binds to `127.0.0.1`, uses ordinary local HTTP, and defaults to `data/personal/workspace.db`. It preserves explicitly supplied `DATA_DIR` and `COUNSEL_DB` values, but refuses any existing unmarked team or legacy database. Team data in `data/workspace.db` is kept separate and is not automatically opened or migrated. A database marker designates the one local identity; extra accounts or a changed identity cause startup to stop.

Personal mode accepts direct same-origin loopback requests only. It rejects remote peers, hostile hostnames, foreign origins, cross-site fetches and proxy-forwarding headers. It refuses production mode, public network binding and a reverse proxy. The browser receives a local session cookie and CSRF token automatically; there is no password prompt. Those internal protections remain necessary to stop other websites from making changes through your browser.

Personal mode is for a computer and operating-system account you control. Other programs or users with access to your files can access the local data. It is not a way to share a confidential workspace over a network. Guest accounts, portal publication and member administration are disabled. Stop the personal server and use an authenticated team installation when collaborating with other people.

## Existing assistants

Open **Settings → Connect Codex / Claude** to create a scoped, expiring connection key. The key authenticates your assistant's tool connection; it does not require app signup or a separate model API. Evidence-only mode remains the default. Existing assistant plans, model-provider limits and infrastructure costs still apply. Personal mode never starts Ollama or downloads model weights.

## Team and Docker installations

`npm start` and the Docker configuration retain local-account login, member roles, matter grants and client guest isolation. Set up the first owner using the token in the team data directory. The production Docker image deliberately rejects personal mode: publishing a no-login container would need a separate, verified network-isolation design.

Both modes are part of the same free software. The repository remains private at its owner's request. There is no subscription gate in the application.
