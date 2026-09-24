---
name: install-openchatx-mcp
description: Install and verify openchatx-mcp on macOS or native Windows, including OpenAI Secure MCP Tunnel, PM2, ChatGPT Developer Mode, MCP servers, and the local dashboard.
---

# Install openchatx-mcp

Install openchatx-mcp collaboratively with the human. Inspect the current machine and repository state first, and resume partial installs rather than repeating completed work.

## Safety and secrets

- Never ask the human to paste OpenAI runtime API keys, ChatGPT credentials, MCP bearer tokens, or other secrets into chat.
- Have them enter secrets directly in their own Terminal, browser, or the local dashboard.
- Do not reset `auth.json` unless the human explicitly wants to rebind the installation to another ChatGPT user.
- Before killing a shared PM2 daemon, inspect what else it manages and obtain explicit approval.

## Requirements

- macOS on Apple Silicon or Intel, or native Windows 10/11 (no WSL required).
- Node.js 22.18.0 or newer.
- npm and git.
- ripgrep (`rg`).
- OpenAI `tunnel-client` on `PATH`.
- A configured Secure MCP Tunnel profile (default: `openchatx`).
- `CONTROL_PLANE_API_KEY` available in the environment that starts OpenChatX.
- ChatGPT Developer Mode for the custom MCP connection.

## Install

From the repository root:

```bash
npm ci
npm run ui:install
npm run setup -- --config-only
```

Initialize the Secure MCP Tunnel profile before full setup:

```bash
export CONTROL_PLANE_API_KEY="<runtime-api-key>"
tunnel-client init --profile openchatx --tunnel-id <tunnel_id> --mcp-server-url http://127.0.0.1:3333/mcp
tunnel-client doctor --profile openchatx --explain
```

Then run:

```bash
npm run setup
```

Review `.openchatx/config.toml`. Persistent OpenChatX state lives under `state_dir` (default `~/.openchatx-mcp`); full setup creates `AGENTS.md` and `skills/` there. There is no separate agent workspace directory. The default tunnel settings are:

```toml
[tunnel]
profile = "openchatx"
health_port = 8080
```

External MCP servers are configured in `mcp-servers.json` or from the dashboard's **MCP Server** page. That file is gitignored and may contain secrets such as Authorization headers.

## Start managed services

The first managed start should come from the human's intended external terminal session (Terminal.app on macOS, PowerShell/Windows Terminal on Windows) with `CONTROL_PLANE_API_KEY` available:

```bash
npm start
```

Then verify:

```bash
npm run status
curl -fsS http://127.0.0.1:3333/healthz
curl -fsS http://127.0.0.1:8080/readyz
npm run print-url
```

The PM2 application names are `openchatx-mcp` and `openchatx-tunnel`.

## ChatGPT setup

In ChatGPT Developer Mode, create an MCP app using **Tunnel** as the connection type, then select the tunnel associated with the configured profile (or paste its `tunnel_...` id). Keep the managed `openchatx-tunnel` process running for connector discovery and MCP calls.

Use the openchatx-mcp icon from `ui/public/openchatx-mcp-icon.png` when desired.

Start a fresh conversation and call `start_here` first, then make a simple `bash` call with `pwd`.

Verify that `~/.openchatx-mcp/auth.json` exists after the first trusted call, but never print its stored subject value.

## Dashboard

OpenChatX UI:

```text
http://127.0.0.1:3333/ui/
```

Tunnel-client operator UI (default):

```text
http://127.0.0.1:8080/ui
```

## Toolboxes

Toolboxes live under `toolboxes/<id>/`. Built-in toolboxes are already provided. Use the dashboard to create templates, toggle tools, reload changed TypeScript tools, and open sources in Finder.

## Completion criteria

Do not call installation complete until:

- `npm run preflight` passes;
- `npm run setup` succeeds;
- `openchatx-mcp` is healthy;
- `openchatx-tunnel` is ready;
- ChatGPT has fetched the tool list through the Secure MCP Tunnel;
- `start_here` and at least one follow-up tool call succeed.
