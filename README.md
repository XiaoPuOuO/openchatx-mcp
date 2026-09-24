<p align="center">
  <img src="ui/public/openchatx-mcp-icon.png" width="96" alt="openchatx-mcp icon">
</p>

<h1 align="center">openchatx-mcp</h1>

<p align="center">
  <strong>English</strong> · <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <strong>Turn ChatGPT into a local agent runtime.</strong><br>
  Operate your Mac, use local tools, discover MCP servers, and delegate work to your own models through one MCP connection.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="macOS">
</p>

> [!NOTE]
> OpenChatX runs inside a normal ChatGPT conversation and does not use Codex as its execution backend. OpenChatX itself therefore does not consume Codex task usage; your ChatGPT plan, message limits, and other usage policies still apply and may change over time.

> [!CAUTION]
> openchatx-mcp runs with the permissions of your local macOS user. An authorized ChatGPT caller can run commands, edit files, fetch webpages, and control connected tools and applications.

![openchatx-mcp architecture](docs/assets/openchatx-mcp-architecture.png)

## Why OpenChatX

ChatGPT is the planner. OpenChatX gives it hands.

- **Local execution** — run shell commands, edit files, inspect images, and use an interactive terminal on your Mac.
- **MCP aggregation** — connect local stdio and remote HTTP MCP servers behind one ChatGPT connection.
- **Capability discovery** — ChatGPT knows Blender, Unreal, browser automation, and other capabilities exist without loading every tool schema into context.
- **Toolboxes** — add your own TypeScript tools and reusable skills as folder-backed plugins.
- **Provider-backed subagents** — delegate bounded work to local GPU models, self-hosted inference, or external APIs while ChatGPT stays the primary planner.
- **Dashboard** — manage MCP servers, toolboxes, and subagents from a local UI.

External MCP tools and custom toolbox tools stay lazy. `start_here` exposes a lightweight capability catalog; ChatGPT uses `tool_search` only when it needs the underlying tools.

## Requirements

- macOS on Apple Silicon or Intel
- Node.js 22.18.0 or newer
- npm
- [ngrok](https://ngrok.com/) account and CLI
- ChatGPT with Developer Mode / custom MCP support available for your account or workspace

Computer Use is intentionally kept outside the core runtime and can be connected as an external MCP.

## Quick start

### Install with a coding agent

Use the bundled install skill:

[`skills/install-openchatx-mcp/SKILL.md`](skills/install-openchatx-mcp/SKILL.md)

### Manual install

```bash
brew install --cask ngrok
git clone https://github.com/XiaoPuOuO/openchatx-mcp.git
cd openchatx-mcp
npm ci

ngrok config add-authtoken <your-token>

npm run setup -- --config-only
npm run setup
npm start
```

Run the first setup from Terminal.app so macOS permissions are granted in a normal interactive session.

### Add OpenChatX to ChatGPT

1. Open **Settings** and enable **Developer Mode**.

   ![Open ChatGPT Settings](docs/assets/enable-developer-mode-step-1.png)

   ![Enable Developer Mode](docs/assets/enable-developer-mode-step-2.png)

2. Open **Plugins**, click **+**, and choose **Create app**.

   ![Create app](docs/assets/create-chatgpt-plugin-step-1.png)

3. Choose **Create MCP app**.

   ![Create MCP app](docs/assets/create-chatgpt-plugin-step-2.png)

4. Configure:
   - Name: `OpenChatX`
   - Server URL: the `https://.../mcp` URL printed by `npm run print-url`
   - Authentication: **No Auth**

   ![Configure OpenChatX](docs/assets/create-chatgpt-plugin-step-3.png)

5. If desired, set the OpenChatX plugin permission to **Allow all tools**.

   ![Allow all OpenChatX tools](docs/assets/openchatx-allow-all-tools.png)

> [!IMPORTANT]
> The first trusted remote tool call binds this installation to that ChatGPT subject. Run `npm run auth:reset` only when you intentionally want to clear that binding.

### Verify

```bash
npm run status
curl -fsS http://127.0.0.1:3333/healthz
npm run print-url
```

```text
MCP: http://127.0.0.1:3333/mcp
UI:  http://127.0.0.1:3333/ui
```

## Capability discovery

OpenChatX does not publish every external MCP or custom-tool schema directly to ChatGPT.

`start_here` returns a compact catalog:

```text
External MCP capabilities:
- blender (Blender): available, 32 tools — 3D modeling and scene control
- unreal-engine (Unreal Engine): available, 3 tools — Unreal Editor automation
```

When a task needs one of those capabilities:

```text
tool_search(
  query="create and modify a 3D model",
  source="mcp",
  server="blender"
)
```

ChatGPT then calls only the discovered tool through `tool_call`. This keeps the main schema surface small while preserving discoverability.

## External MCP servers

Fresh installs start with no external MCP servers configured. Add them from the Dashboard or create the gitignored `mcp-servers.json`.

```json
{
  "open-computer-use": {
    "type": "local",
    "command": ["/opt/homebrew/bin/open-computer-use", "mcp"],
    "enabled": true,
    "description": "macOS GUI control"
  }
}
```

Unavailable servers do not prevent OpenChatX from starting; they stay visible in the capability catalog as configured but unavailable.

## Provider-backed subagents

OpenChatX can delegate work to models you explicitly configure. Providers do not automatically expose their entire model catalog; you create curated model profiles instead.

Fresh installs start empty:

```json
{
  "providers": {},
  "models": {}
}
```

Configure profiles from the Dashboard or in the gitignored `subagents.json`.

- `subagent_list` — list curated profiles and their intended use.
- `subagent_run` — delegate one task to one selected profile.

## Toolboxes

Toolboxes are folder-backed plugins under `toolboxes/`:

```text
toolboxes/
└── my-tools/
    ├── toolbox.json
    ├── tools/
    │   └── hello.ts
    └── skills/
        └── debug-app/
            └── SKILL.md
```

The Dashboard can enable or disable toolboxes, tools, and skills, and create starter templates. Custom tools are discovered lazily through `tool_search` and called through `tool_call`.

## File workflow

```text
read → edit/write → patch only when appropriate
```

- `file_read` — inspect text files or directories with line-numbered pagination.
- `file_edit` — exact replacement for localized edits to existing text files; returns a diff.
- `file_write` — create or completely overwrite a text file; returns a diff.
- `apply_patch` — structured multi-file patches, moves/deletes, or user-supplied patches.

## Configuration

```text
.openchatx/config.toml   # runtime, workspace, shell, ngrok, MCP output
mcp-servers.json        # external MCP servers
subagents.json          # providers and curated model profiles
toolboxes/              # built-in and custom toolboxes
```

To keep the ChatGPT connector URL stable across restarts:

```toml
[ngrok]
url = "https://your-static-domain.ngrok-free.dev"
```

The Dashboard is always available at `/ui`.

## Operations

| Command | Purpose |
| --- | --- |
| `npm start` | Build and start/reload OpenChatX and ngrok |
| `npm run restart` | Rebuild and reload services |
| `npm run restart -- --hard` | Rebuild and recreate the dedicated PM2 daemon from Terminal.app |
| `npm run status` | Show service status |
| `npm run logs` | Show service logs |
| `npm run print-url` | Print the public MCP URL and local UI URL |
| `npm run stop` | Stop OpenChatX and ngrok |
| `npm run auth:reset` | Clear the bound ChatGPT subject after confirmation |

See [Configuration and Startup](wiki/pages/operations/configuration-and-startup.md) for recovery details.

## Security

- Only connect MCP servers you trust.
- The localhost MCP endpoint has no extra authentication; do not expose it through an untrusted proxy.
- Trusted remote calls are bound to the first ChatGPT subject stored in `<state_dir>/auth.json`.
- `agent-commands.yaml` may contain sensitive tool inputs and is intentionally gitignored.

See [SECURITY.md](SECURITY.md).

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run ui:lint
npm run ui:build
```

- `npm run inspect` — open MCP Inspector.
- `npm run schemas` — print the currently published MCP tool schemas.

More implementation details live in the [Maintainer Wiki](wiki/).

## License

[MIT](LICENSE).

The vendored `apply_patch` binary retains its upstream OpenAI Codex license and notices under [`vendor/apply-patch/`](vendor/apply-patch/).

## Attribution

Parts of this project are derived from [Shellby MCP](https://github.com/Serbyte-Development/shellby-mcp), originally created by Serbyte Development under the MIT License. The original notice is preserved in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
