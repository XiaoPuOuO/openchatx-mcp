<p align="center">
  <img src="ui/public/openchatx-mcp-icon.png" width="96" alt="OpenChatX icon">
</p>

<h1 align="center">OpenChatX</h1>

<p align="center">
  <strong>English</strong> · <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <strong>Build your own ChatGPT agent workflow — without building the agent runtime from scratch.</strong><br>
  OpenChatX is a batteries-included, fully customizable local agent platform: coding-grade file and shell tools, computer control, MCP aggregation, Skills, Rules, Projects, Tasks, Subagents, and more — all exposed through one official ChatGPT MCP connection, with Toolboxes to customize how your agent works.
</p>

<p align="center">
  <a href="https://github.com/XiaoPuOuO/openchatx-mcp/releases/latest"><strong>Download latest release</strong></a>
</p>

> [!CAUTION]
> OpenChatX runs with your local user permissions. A trusted ChatGPT caller can run commands, edit files, use connected MCP servers, and control supported applications.

## How it works — official MCP, no reverse engineering

OpenChatX uses OpenAI's **documented MCP integration path**. It does not reverse-engineer ChatGPT, call undocumented ChatGPT backend endpoints, reuse browser session cookies, or intercept ChatGPT traffic.

The connection works like this:

1. **OpenChatX runs a normal MCP server locally** on your machine.
2. **OpenAI's official `tunnel-client` creates an outbound HTTPS connection** to an OpenAI Secure MCP Tunnel. Your local MCP server does not need a public inbound port.
3. **ChatGPT connects to that tunnel as a custom MCP app** using the supported ChatGPT Developer Mode / MCP app flow.
4. When ChatGPT invokes a tool, the Secure MCP Tunnel forwards the MCP request to OpenChatX locally and returns the MCP response through the same official channel.
5. OpenChatX then routes that request to local tools, your computer, connected MCP servers, Skills, Rules, Projects, or explicitly configured Subagents.

ChatGPT remains the model and planner. OpenChatX is the local tool/runtime layer; it does not impersonate ChatGPT or make hidden model calls on ChatGPT's behalf.

The Runtime API key configured in OpenChatX is used for the official Secure MCP Tunnel control plane and is stored in the operating-system credential store. It is not a scraped ChatGPT credential or a workaround around ChatGPT's supported interfaces.

Official references:

- OpenAI Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- ChatGPT Developer Mode and MCP apps: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt

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

### 1. Create the ChatGPT MCP app

Open ChatGPT **Settings** and enable **Developer Mode**.

![Open ChatGPT Settings](docs/assets/enable-developer-mode-step-1.png)

![Enable Developer Mode](docs/assets/enable-developer-mode-step-2.png)

Then open **Plugins**, click **+**, choose **Create app**, and then choose **Create MCP app**.

![Create app](docs/assets/create-chatgpt-plugin-step-1.png)

![Create MCP app](docs/assets/create-chatgpt-plugin-step-2.png)

Enter the app name and description, switch the connection type to **Tunnel**, and click **Create tunnel**.

![Choose Tunnel and create a tunnel](docs/assets/secure-tunnel-chatgpt-create.png)

### 2. Create the tunnel in OpenAI Platform

Open the OpenAI Platform Tunnels page:

https://platform.openai.com/settings/organization/tunnels

Click **Create tunnel**, then configure:

1. **Name** — for example, `OpenChatX Tunnel`.
2. **Description** — for example, `OpenChatX Tunnel`.
3. **Organizations** — select the organization that should own the tunnel.
4. **ChatGPT workspaces** — select the ChatGPT workspace that will use OpenChatX.
5. Click **Create**.

![Create the OpenChatX tunnel](docs/assets/secure-tunnel-platform-create.png)

After creation, copy the resulting `tunnel_...` ID. You will enter this in OpenChatX Desktop.

### 3. Create the Runtime API key

Open the OpenAI Platform API Keys page:

https://platform.openai.com/settings/organization/api-keys

Create a new secret key for the OpenChatX tunnel runtime. A name such as `OpenChatX Runtime Key` makes it easier to identify later.

![Create the OpenChatX runtime API key](docs/assets/secure-tunnel-runtime-key.png)

Copy the secret when it is shown. Do not commit it to Git or paste it into chat.

### 4. Connect the Desktop App

Open OpenChatX Desktop → **More → Connect Tunnel…**

Enter:

- **Tunnel ID** — the `tunnel_...` ID from step 2.
- **Control-plane API key** — the Runtime API key from step 3.

The Desktop App stores the API key in the operating-system credential store:
- macOS: Keychain
- Windows: Credential Manager

### 5. Finish the ChatGPT MCP app

Return to ChatGPT:

1. Select the newly created `openchatx (tunnel_...)` tunnel.
2. Set authentication to **No authentication**.
3. Read and accept the custom MCP risk acknowledgement.
4. Click **Create**.

![Select the tunnel and create the OpenChatX app](docs/assets/secure-tunnel-chatgpt-finish.png)

If you want ChatGPT to use OpenChatX tools without prompting for every tool call, you can set the OpenChatX app permission to **Allow all tools**.

![Allow all OpenChatX tools](docs/assets/openchatx-allow-all-tools.png)

Useful links:

- OpenAI Secure MCP Tunnel guide: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- OpenAI Tunnels settings: https://platform.openai.com/settings/organization/tunnels
- OpenAI API keys: https://platform.openai.com/settings/organization/api-keys

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

Skills are portable Agent Skills owned by a Toolbox:

```text
toolboxes/<toolbox>/skills/<name>/SKILL.md
```

A Skill contains `name`, `description`, and Markdown instructions. Skills are not injected at startup.

- `skill_search` finds up to five relevant Skills by name/description.
- `skill_load` loads the full Markdown only after a Skill is selected.
- `skill_manage` creates, edits, or deletes user Skills.

### Rules

Rules are owned by a Toolbox and live beside that Toolbox's other capabilities:

```text
toolboxes/<toolbox>/rules/<name>.mdc
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
