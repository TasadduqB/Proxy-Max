# Proxy-Max

A local proxy that **speaks the Anthropic Messages API** but routes every request to
**AWS Bedrock**, **Azure AI Foundry**, or **NVIDIA NIM** (`build.nvidia.com`).
Drop it in front of the official `claude` CLI and you can drive *any* of those
backends from the same tooling — with full streaming, tool calls, and multi-modal
content translated transparently.

```
                        ┌───────────────────────────────┐
 claude  ── /v1/messages ──▶  Proxy-Max  ── translates ──▶  Bedrock / Azure / NVIDIA
        ◀── SSE stream  ──   :8787       ◀── SSE stream  ──
                        └───────────────────────────────┘
```

## What you get

- **Web UI** at `http://127.0.0.1:8787/` — pick the source on top, choose a model, paste endpoint + key, hit save. Connection-test button included.
- **Streaming** translated end-to-end: upstream SSE / event-stream → Anthropic `message_start / content_block_delta / …` events.
- **Tool use** translated both directions (Anthropic `tool_use` ↔ OpenAI `tool_calls` ↔ Bedrock native).
- **Zero npm dependencies** — pure Node 18+. AWS SigV4 done in-tree.
- **Smart bootstrap** that installs Node, npm, and the Anthropic CLI on any machine, with or without admin (falls back to a per-user prefix and portable Node tarball when needed).

## Quick start

### macOS / Linux
```bash
bash ./bootstrap.sh
```

### Windows
```powershell
powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

Either script will:
1. find or install Node + npm (Homebrew, apt, dnf, pacman, winget, or portable),
2. find or install `@anthropic-ai/claude-code` (admin → global; no admin → per-user prefix),
3. start the proxy server on `127.0.0.1:8787`,
4. print the UI URL.

Open the UI, pick a source, fill in the endpoint + API key, click **Save & activate**, then run:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
ANTHROPIC_AUTH_TOKEN=proxy-max \
claude
```

Or have the bootstrap launch the CLI for you:
```bash
./bootstrap.sh --claude
```

## Provider notes

### AWS Bedrock
- Best for Anthropic Claude models hosted on Bedrock — payload is forwarded almost untouched.
- Needs `accessKeyId` + `secretAccessKey` (and optional `sessionToken` for SSO/STS).
- Model id examples: `anthropic.claude-3-5-sonnet-20241022-v2:0`, `us.anthropic.claude-sonnet-4-20250514-v1:0`.

### Azure AI Foundry
Two endpoint shapes are supported and the UI exposes both:
- **Azure OpenAI deployments** — set *Endpoint* to `https://<resource>.openai.azure.com` and fill the *Deployment name*.
- **Foundry direct inference** — set *Endpoint* to `https://<resource>.services.ai.azure.com/models` and leave Deployment blank.

The proxy authenticates with `api-key` and `Authorization: Bearer` headers (one of which every Foundry surface accepts).

### NVIDIA NIM (build.nvidia.com)
- Endpoint defaults to `https://integrate.api.nvidia.com/v1`. For self-hosted NIMs, point it at your NIM's `/v1` URL.
- API key from <https://build.nvidia.com>.

## Architecture / files

```
src/
  server.js              ← HTTP server: /v1/messages, /api/*, static UI
  launch.js              ← one-shot: ensure deps → spawn server → exec claude
  install.js             ← node + npm + claude installer with admin/no-admin paths
  providers/
    _common.js           ← Anthropic SSE emitter + payload translation helpers
    openai_compat.js     ← Azure & NVIDIA (OpenAI Chat Completions)
    bedrock.js           ← Bedrock invoke / invoke-with-response-stream + SigV4
ui/index.html            ← single-file config UI (no build step)
bootstrap.sh / .ps1      ← cross-platform bootstrap
config.json              ← persisted config (created on first save)
```

## Diagnostics

```bash
node src/install.js --doctor    # show node/npm/claude paths it can find
node src/install.js             # install anything missing
```

### Panel click/impression test

This project now includes a local panel event test flow so you can verify that
impressions and clicks are reflected in the diagnostics panel.

1. Start server:

```bash
npm run start
```

2. In another terminal run:

```bash
npm run test:panel
```

What it validates:
- `POST /api/panel/reset`
- `POST /api/panel/event` (impression + click)
- `GET /api/panel/summary`
- `GET /api/panel/events`

Expected result: summary shows `total=2`, `impressions=1`, `clicks=1`, `ctr=1`.

`~/.proxy-max/server.log` (or `%USERPROFILE%\.proxy-max\server.log` on Windows) holds proxy logs when started by bootstrap.

## Notes

- `ANTHROPIC_AUTH_TOKEN` can be any non-empty value; the proxy doesn't validate it. The proxy itself binds to `127.0.0.1` only by default. Override with `HOST=0.0.0.0 PORT=9000` if you want it reachable on the LAN.
- API keys are stored locally in `config.json`. They're masked in the UI/API responses and never logged.
