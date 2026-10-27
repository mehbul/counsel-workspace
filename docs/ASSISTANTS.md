# Use Counsel with your assistant or local model

Counsel requires no Legora account or subscription and no mandatory paid model API. This repository remains private at its owner's request; users need repository access or a legitimately shared copy before installation. The project's existing package license is ISC. Dependencies, models and third-party services retain their own licenses and terms.

## Choose a reasoning mode

| Mode                    | Where reasoning runs                                    | Additional model API required by Counsel?                              |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Evidence only (default) | A person reads retrieved source passages                | No                                                                     |
| Assistant through MCP   | Your existing Codex, Claude Code or compatible MCP host | No; usage still counts toward the host's plan and limits               |
| Local Ollama model      | A model you install and serve on your computer          | No paid model API for locally executed inference; hardware is required |
| Optional API endpoint   | A provider you explicitly configure                     | Provider billing and quotas may apply                                  |

An ordinary chatbot web page is not automatically an MCP host. This repo supplies a local **stdio** adapter and an authenticated **Streamable HTTP** endpoint. OAuth registration and OAuth-only chatbot connections are not supported. For DeepSeek, use an MCP-capable host with your chosen model, or a locally served model/compatible endpoint. The official DeepSeek API is a separate, potentially billable service.

## Start the workspace

With Node 24.15 or newer, run `npm ci` then `npm start`. Open http://127.0.0.1:3000 and create the owner account using the token in `data/bootstrap-token`. Setup deletes that token after success. Create a matter or use the synthetic examples.

`AI_PROVIDER` defaults to `evidence`, even if an OpenAI API key is present. Model generation requires explicit configuration. The MCP tools always avoid model APIs, independently of the web app's model configuration.

## Connect an existing assistant

1. Sign in as an owner/editor with access to the intended matters.
2. Open **Account → Connect Codex / Claude**.
3. Create a named key. Choose its matter scope, expiry and read-only or write mode. Read-only is the default. Write access adds imports and creation of unreviewed work; it cannot administer accounts, grant access, approve workflows or send messages.
4. Download `counsel-connection.json` to a private location outside the repo. It contains a bearer credential, not a model-provider credential. Keep it out of shared folders and Git.
5. Use the setup wizard to choose Codex, Claude Code or a desktop JSON client and download its settings. For local stdio, enter absolute adapter and private connection-file paths. Settings are downloaded for you to merge; existing client configurations are never overwritten. The workspace must be running when tools are called.
6. Use **Test key and workspace** to check current permissions, then run `counsel_session` in the assistant to verify its own client connection. The browser check cannot establish that a native client was configured correctly.

### Codex

Merge this into your MCP configuration, preserving existing servers:

```toml
[mcp_servers.counsel]
command = "node"
args = ["/absolute/path/to/counsel-workspace/mcp/server.mjs", "--connection-file", "/private/path/counsel-connection.json"]
```

On Windows, forward slashes work inside these strings: `C:/Users/YourName/counsel-workspace/mcp/server.mjs`. Replace both example paths. Reconnect the client and inspect the `counsel_*` tools. This repository does not change client settings automatically.

### Claude Code and other local MCP clients

```sh
claude mcp add --transport stdio counsel -- node /absolute/path/to/counsel-workspace/mcp/server.mjs --connection-file /private/path/counsel-connection.json
```

Quote paths containing spaces. Check with `claude mcp get counsel` or `/mcp`. Generic desktop-client JSON and Codex TOML examples are in `mcp/examples/`. Their configuration locations depend on the host. Launch `node` directly: unsilenced `npm run` banners can corrupt stdout, which carries the MCP protocol.

### Direct HTTP and diagnostics

The endpoint is `https://your-workspace.example/agent/v1/mcp` (loopback HTTP is usable locally). A compatible client must send `Authorization: Bearer <your-assistant-key>` on **every** request. It uses the installed MCP SDK's stateless Streamable HTTP transport with JSON responses. Authentication is checked before protocol discovery and again before each tool operation. Scope, expiry, member access, revocation and write request IDs use the same enforcement as stdio. There is no OAuth discovery or dynamic registration. Configure TLS and an explicit `APP_ORIGIN` for remote hosting; do not expose credentials over remote plaintext HTTP.

Codex HTTP configuration:

```toml
[mcp_servers.counsel]
url = "https://your-workspace.example/agent/v1/mcp"
bearer_token_env_var = "COUNSEL_ASSISTANT_TOKEN"
```

Set that environment variable privately before launching Codex. For Claude Code choose the wizard's HTTP JSON settings and merge the `counsel` entry into `.mcp.json` only if it is private and excluded from version control. A generic JSON download does not guarantee a desktop client supports HTTP or custom headers; use stdio if its client does not.

For a key check without any model usage:

```sh
node mcp/diagnose.mjs --connection-file /private/path/counsel-connection.json
```

It reports connectivity, access mode, matter count and expiry without displaying credentials or documents. A failure with a valid URL usually means Counsel is stopped or the key expired/revoked. If the diagnostic passes but the assistant cannot connect, check its absolute paths, Node availability, client transport support and environment, then reconnect the client. `mcp/start.cmd --connection-file ...` on Windows or `sh mcp/start.sh --connection-file ...` on POSIX launches the stdio adapter from any current directory. Node 24.15+ must be on PATH; no settings are installed automatically.

### Try an actual workflow

Ask your assistant:

> Use Counsel to list my authorized matters. After I choose one, read the relevant sources and compare governing-law provisions. Cite exact numbered paragraphs. Save your analysis as an unreviewed comparison table and draft memorandum for my review. Use no separate model API through Counsel.

The host reads evidence and performs the analysis itself. It can save its results through `counsel_save_review` and `counsel_create_draft`. A guided prompt, `counsel_prepare_matter_memo`, is advertised. Use a new UUID `requestId` for each new write; reuse that ID with identical input when retrying.

Results appear in Tabular review, Editor and Lists. Exact-quote checks reject fabricated source references; they do not prove that a legal interpretation is correct. Saved work stays unreviewed.

There are 15 tools: connection information; paginated matter/document/draft lists; bounded source/draft/review reading; ranked evidence search; passage comparison and reference-integrity checks; text import; local extraction review creation; host-authored review and draft saving; and task creation. They do not execute arbitrary code, access arbitrary files, call external model APIs, or reuse assistant-provider login credentials.

## Run a local model in the web app

Install and run Ollama separately. Choose a locally served model suitable for your hardware and licensed for your intended use. `ollama list` shows installed models. This repo does not silently download weights or start cloud inference.

In PowerShell:

```powershell
$env:AI_PROVIDER = 'ollama'
$env:OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
$env:OLLAMA_MODEL = 'your-installed-model'
npm start
```

Assistant responses and drafts now use Ollama's native `/api/chat` endpoint without a provider API key. Select a local model, not a cloud-model alias, for local-only execution. The sidebar reports configuration, not a guarantee that the server is reachable.

For Docker, set the same variables in `.env`; the default endpoint is `http://host.docker.internal:11434`. The model server must be reachable from the container on an appropriate private interface. Follow its deployment/network documentation; do not expose an unauthenticated model server to the internet.

For an OpenAI-compatible local server:

```powershell
$env:AI_PROVIDER = 'openai-compatible'
$env:AI_BASE_URL = 'http://127.0.0.1:1234/v1'
$env:AI_MODEL = 'your-loaded-model'
npm start
```

Remote endpoints require HTTPS. Set `AI_API_KEY` when your chosen service requires it. DeepSeek's official endpoint can use `https://api.deepseek.com` and an available model name, but is potentially billable. Existing OpenAI API users must now explicitly set `AI_PROVIDER=openai` alongside `OPENAI_API_KEY`; `OPENAI_MODEL` retains its meaning. Set `AI_PROVIDER=evidence` to disable generation.

## Permissions and data boundary

Keys are hashed in SQLite, revealed once, expire within 90 days, and can be revoked through Account. Every call checks key status and intersects its matter scope with the member's current grants. Revoking a matter grant or disabling the member affects subsequent calls. Viewers cannot create keys. Changing or recovering a login password and disabling a member revoke all of that member's assistant keys and sessions. Re-enabling a member does not restore old keys. Reconnect with a new key.

Tool results enter the connected assistant's context under its provider's data policy. A self-hosted database does not make a cloud assistant local. Read-only keys cannot create work. No bridge key can declare an output human-approved.

## Verification and limits

`npm test` launches real MCP SDK clients over stdio and Streamable HTTP and checks discovery, scoped reads, outputs, citations, idempotency, revocation, expiry, current member access, pagination and unsafe URLs. Model adapters also have synthetic-response tests.

On 25 October 2026, a live **Codex CLI 0.164.0-alpha.11.1** run using existing ChatGPT sign-in passed the full MCP path: list matters/documents, read the synthetic NDA, save a host-authored review, and save a cited memorandum. The server remained in evidence-only mode and made no separate model API call. The fixture verified persisted artifacts and tool-call traces, then revoked its key and removed its temporary data. Saved Codex configuration was not changed. Repeat this optional test with `node scripts/smoke-codex.js`; it consumes the signed-in Codex account's normal usage allowance.

A separate live local-model check also passed the synthetic account/source/chat path. It is optional: `node scripts/smoke-local-model.js your-installed-model`. No background model service is required for Codex/MCP mode. Legal-quality benchmarks, a specific DeepSeek model, and real Claude client integration remain unverified.

This is a usable assistant-powered workspace; full Legora parity has not been established. Client portals, an Office bridge and public regulatory feeds are implemented. Enterprise permission mirroring, live Office/enterprise tenant acceptance, licensed research and comparative legal quality remain gaps; see `WORKFLOW-PARITY.md`.

## Primary references

- [Codex MCP](https://developers.openai.com/codex/mcp)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [MCP SDK guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-server.md)
- [Ollama chat API](https://docs.ollama.com/api/chat)
- [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility)
- [DeepSeek API](https://api-docs.deepseek.com/)
