<p align="center">
  <img src="ui/public/openchatx-mcp-icon.png" width="96" alt="OpenChatX icon">
</p>

<h1 align="center">OpenChatX</h1>

<p align="center">
  <strong>English</strong> · <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <strong>Turn ChatGPT into a local agent runtime.</strong><br>
  One MCP connection for your computer, MCP servers, custom tools, Skills, Rules, Projects, Subagents, and more.
</p>

<p align="center">
  <a href="https://github.com/XiaoPuOuO/openchatx-mcp/releases/latest"><strong>Download latest release</strong></a>
</p>

> [!CAUTION]
> OpenChatX runs with your local user permissions. A trusted ChatGPT caller can run commands, edit files, use connected MCP servers, and control supported applications.

## Install the Desktop App

This is the recommended way to use OpenChatX. You do **not** need to install Node.js, npm, PM2, or `tunnel-client` yourself.

### macOS

Download the matching DMG from the latest release:

- Apple Silicon: `OpenChatX-macos-arm64.dmg`
- Intel Mac: `OpenChatX-macos-x64.dmg`

The macOS release is signed with Developer ID and notarized by Apple.

### Windows

For most PCs, download:

- `OpenChatX-Setup-x64.exe`

For Windows on ARM:

- `OpenChatX-Setup-arm64.exe`

Portable ZIPs are also available.

> [!WARNING]
> **Windows may warn because the binary is unsigned.**
> The Windows build is currently distributed without Authenticode signing. Download it only from this repository's GitHub Releases page.

Latest release:

https://github.com/XiaoPuOuO/openchatx-mcp/releases/latest

## Connect OpenChatX to ChatGPT

OpenChatX uses OpenAI Secure MCP Tunnel. The Desktop App manages the local runtime and bundled `tunnel-client`; you only need to create the tunnel once.

1. In ChatGPT, enable Developer Mode and create a new MCP app using **Tunnel**.
2. In OpenAI Platform, create a tunnel for OpenChatX and copy its `tunnel_...` ID.
3. Create an OpenAI runtime API key for the tunnel.
4. Open OpenChatX Desktop → **More → Connect Tunnel…**
5. Enter the Tunnel ID and API key.
6. Return to ChatGPT, select that tunnel, use **No authentication**, and finish creating the MCP app.

Useful links:

- OpenAI Secure MCP Tunnel guide: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- OpenAI Tunnels settings: https://platform.openai.com/settings/organization/tunnels
- OpenAI API keys: https://platform.openai.com/settings/organization/api-keys

The Desktop App stores the tunnel API key in the operating system credential store:
- macOS: Keychain
- Windows: Credential Manager

## What OpenChatX gives ChatGPT

| Feature | What it does |
| --- | --- |
| MCP Servers | Connect local or remote MCP servers behind one OpenChatX connection |
| Toolboxes | Add or manage custom TypeScript tools |
| Skills | Portable `SKILL.md` workflows, loaded only when needed |
| Rules | Persistent `.mdc` rules with Always / Auto Attached / Agent Requested / Manual modes |
| AGENTS.md | Editable `start_here` template with runtime placeholders |
| Projects | Bind ChatGPT work to existing folders without moving them |
| Subagents | Delegate work to explicitly configured model profiles |
| Capability Store | Install built-ins or inspect/install GitHub-hosted community capabilities |
| Dashboard | Manage sessions, tools, Skills, Rules, MCP servers, Projects, status, and more |

External MCP and Toolbox schemas stay lazy so the normal ChatGPT tool context stays small.

## Skills, Rules, and AGENTS.md

### Skills

Skills are portable Agent Skills:

```text
~/.openchatx-mcp/skills/<name>/SKILL.md
```

A Skill contains `name`, `description`, and Markdown instructions. Skills are not injected at startup.

- `skill_search` finds up to five relevant Skills by name/description.
- `skill_load` loads the full Markdown only after a Skill is selected.
- `skill_manage` creates, edits, or deletes user Skills.

### Rules

Rules live in:

```text
~/.openchatx-mcp/rules/*.mdc
```

Example:

```md
---
description: "React component conventions"
globs:
  - "src/**/*.tsx"
alwaysApply: false
---

Use accessible labels and named exports.
```

OpenChatX supports four Rule modes:

- **Always** — injected by `start_here`.
- **Auto Attached** — activated by matching file globs.
- **Agent Requested** — selected from the description when relevant.
- **Manual** — loaded only when explicitly requested.

Rules can be imported/exported with Cursor `.mdc`, Claude Rules, and `AGENTS.md`.

### AGENTS.md

`~/.openchatx-mcp/AGENTS.md` is the editable template used by `start_here`.

The Toolbox UI exposes it directly. Runtime data is inserted through placeholders such as:

- `{{MODE_INSTRUCTIONS}}`
- `{{PROJECT_CONTEXT}}`
- `{{CAPABILITY_CATALOG}}`
- `{{ALWAYS_RULES}}`

Move or remove placeholders to control what `start_here` returns.

## Connect more capabilities

You can usually just ask ChatGPT:

> Add this MCP server to OpenChatX and verify it works.

or:

> Create an OpenChatX tool that starts my local service and returns its status.

OpenChatX can manage MCP servers, Toolboxes, Skills, Rules, Projects, and Subagents from the Dashboard or through its management tools.

## Manual / source install

Use this only if you do not want the Desktop App.

### Requirements

- Node.js 22.18+
- npm
- ripgrep
- OpenAI `tunnel-client`
- ChatGPT Developer Mode / custom MCP access

### macOS

```bash
brew install ripgrep
git clone https://github.com/XiaoPuOuO/openchatx-mcp.git
cd openchatx-mcp
npm ci
npm run setup -- --config-only
```

### Windows PowerShell

```powershell
winget install BurntSushi.ripgrep.MSVC
git clone https://github.com/XiaoPuOuO/openchatx-mcp.git
Set-Location openchatx-mcp
npm ci
npm run setup -- --config-only
```

Then install the official OpenAI `tunnel-client`, create the `openchatx` tunnel profile, export `CONTROL_PLANE_API_KEY`, and run:

```bash
npm run setup
npm start
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run status` | Show runtime/tunnel status |
| `npm run logs` | Show runtime logs |
| `npm run print-url` | Print local MCP/UI/tunnel URLs |
| `npm run restart` | Rebuild and reload services |
| `npm run stop` | Stop managed services |
| `npm run auth:reset` | Clear the bound ChatGPT subject |

## Development

```bash
npm ci
npm --prefix ui ci
npm run lint
npm run typecheck
npm test
npm run build
npm --prefix ui run build
```

Desktop build commands:

```bash
npm run desktop:build
npm run desktop:smoke
npm run desktop:windows:build
npm run desktop:windows:build:arm64
```

Maintainer docs: [wiki/](wiki/)

## Security

- Only connect MCP servers you trust.
- The local MCP endpoint is intended to stay on loopback.
- Secure MCP Tunnel is the supported remote path.
- Tool/audit logs may contain sensitive inputs.
- See [SECURITY.md](SECURITY.md) for the security model and reporting instructions.

## License

MIT — see [LICENSE](LICENSE).

Parts of this project are derived from [Shellby MCP](https://github.com/Serbyte-Development/shellby-mcp); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
