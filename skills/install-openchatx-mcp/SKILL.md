---
name: install-openchatx-mcp
description: Install and verify openchatx-mcp on macOS, including ngrok, PM2, ChatGPT Developer Mode, MCP servers, and the local dashboard.
---

# Install openchatx-mcp

Install openchatx-mcp collaboratively with the human. Inspect the current machine and repository state first, and resume partial installs rather than repeating completed work.

## Safety and secrets

- Never ask the human to paste ngrok tokens, ChatGPT credentials, MCP bearer tokens, or other secrets into chat.
- Have them enter secrets directly in their own Terminal, browser, or the local dashboard.
- Do not reset `auth.json` unless the human explicitly wants to rebind the installation to another ChatGPT user.
- Before killing a shared PM2 daemon, inspect what else it manages and obtain explicit approval.

## Requirements

- macOS on Apple Silicon or Intel.
- Node.js 22.18.0 or newer.
- npm and git.
- ngrok when remote ChatGPT access is desired.
- ChatGPT Developer Mode for the custom MCP connection.

## Install

From the repository root:

```bash
npm ci
npm run ui:install
npm run setup -- --config-only
npm run setup
```

Review `.openchatx/config.toml`. Built-in tool enablement is managed from the **Toolboxes** page rather than `[tools]` settings in TOML. The runtime uses `~/.openchatx-mcp` for new state and migrates an existing legacy authentication binding on first launch without sharing the old PM2 daemon.

External MCP servers are configured in `mcp-servers.json` or from the dashboard's **MCP Server** page. That file is gitignored and may contain secrets such as Authorization headers.

## ngrok

Check authentication without printing credentials:

```bash
ngrok config check
```

If authentication is missing, have the human run this themselves:

```bash
ngrok config add-authtoken <their-token>
```

Run:

```bash
npm run preflight
```

For local-only use, set:

```toml
[ngrok]
enabled = false
```

## Start managed services

The first managed start should come from the human's intended Terminal.app session:

```bash
npm start
```

Then verify:

```bash
npm run status
curl -fsS http://127.0.0.1:3333/healthz
npm run print-url
```

The PM2 application names are `openchatx-mcp` and, when ngrok is enabled, `openchatx-ngrok`.

## ChatGPT setup

In ChatGPT Developer Mode, create a custom MCP connection using the printed `https://.../mcp` URL and select **No Auth**. The ngrok traffic policy restricts the public endpoint to ChatGPT-origin traffic, and the first trusted remote tool call binds the local installation to that ChatGPT subject.

Use the openchatx-mcp icon from `ui/public/openchatx-mcp-icon.png` when desired.

Start a fresh conversation and call `start_here` first, then make a simple `bash` call with `pwd`.

Verify that `~/.openchatx-mcp/auth.json` exists after the first trusted call, but never print its stored subject value.

## Dashboard

When `[ui].enabled = true`, open:

```text
http://127.0.0.1:3333/ui/
```

The dashboard can:

- observe active agents and tool calls;
- steer an active agent;
- manage external MCP servers;
- manage toolboxes, built-in tools, custom TypeScript tools, and toolbox skills.

## Toolboxes

Toolboxes live under `toolboxes/<id>/`. Built-in toolboxes are already provided. Custom toolboxes may contain:

```text
toolboxes/my-tools/
├── toolbox.json
├── tools/
│   └── hello.ts
└── skills/
    └── debug-app/
        └── SKILL.md
```

Use the dashboard to create templates, toggle tools, reload changed TypeScript tools, and open sources in Finder.

## Completion criteria

Do not call installation complete until:

- `npm run preflight` passes;
- `npm run setup` succeeds;
- the managed MCP process is healthy;
- the public `/mcp` URL works when ngrok is enabled;
- ChatGPT has fetched the tool list;
- `start_here` and at least one follow-up tool call succeed.
