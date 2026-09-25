<p align="center">
  <img src="ui/public/openchatx-mcp-icon.png" width="96" alt="openchatx-mcp icon">
</p>

<h1 align="center">openchatx-mcp</h1>

<p align="center">
  <strong>English</strong> · <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <strong>One MCP connection. Every capability on your machine.</strong><br>
  OpenChatX is a capability runtime for ChatGPT: local execution, MCPs, custom tools, providers, agents, workflows, projects, and remote OpenChatX nodes behind one connection.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg" alt="macOS and Windows">
</p>

> [!NOTE]
> OpenChatX runs inside a normal ChatGPT conversation and does not use Codex as its execution backend. OpenChatX itself therefore does not consume Codex task usage; your ChatGPT plan, message limits, and other usage policies still apply and may change over time.

> [!CAUTION]
> openchatx-mcp runs with the permissions of your local operating-system user. An authorized ChatGPT caller can run commands, edit files, fetch webpages, and control connected tools and applications.

![openchatx-mcp architecture](docs/assets/openchatx-mcp-architecture.png)

## Why OpenChatX

ChatGPT is the planner. OpenChatX gives it hands.

I use AI agents heavily for real development work, and I once burned through 100% of my Pro 20x Codex Weekly Usage in about half a day. I did not want my entire workflow tied to the usage limits of a single agent runtime, so I built OpenChatX: ChatGPT can work directly with my local machine, tools, MCP servers, and models from a normal conversation instead of requiring Codex as the execution backend.

- **Universal MCP gateway** — connect local stdio and remote HTTP MCP servers behind one ChatGPT connection.
- **Unified capabilities** — MCP servers, Toolboxes, model profiles, and Providers are exposed through one capability catalog instead of four disconnected concepts.
- **Custom Toolboxes** — add TypeScript tools and reusable skills as hot-reloadable folder-backed plugins.
- **Provider Hub + smart routing** — connect hosted APIs, Ollama, LM Studio, vLLM, or other OpenAI-compatible Providers and route work by tags, locality, context size, and cost tier.
- **Durable Jobs** — keep long-running commands alive beyond one MCP request and inspect them later.
- **Projects** — register existing project roots without moving files and give each root explicit read/write/shell permissions.
- **Agent Teams** — run one task across multiple curated model profiles while ChatGPT remains the planner and integrator.
- **Capability Composer** — save reusable cross-capability workflows that chain MCP/custom tools, subagents, teams, and durable jobs.
- **Capability Store** — install built-in bundles or discover unreviewed community capabilities directly from public GitHub repositories; inspect source and pin the exact reviewed commit before install.
- **Multi-machine Nodes** — connect other OpenChatX machines and discover/call their tools from one primary ChatGPT connection.
- **Platform Dashboard** — see projects, current work, capability health, Providers, Teams, Workflows, Nodes, and anything that needs attention.

External MCP and custom Toolbox tools stay lazy. `start_here` exposes lightweight capability summaries; `capability_list` provides the unified catalog and `tool_search` loads underlying tool schemas only when needed.

## Requirements

- macOS on Apple Silicon or Intel, or native Windows 10/11
- Node.js 22.18.0 or newer
- npm
- ripgrep (`rg`)
- [OpenAI tunnel-client](https://github.com/openai/tunnel-client) on PATH
- ChatGPT with Developer Mode / custom MCP support available for your account or workspace

Windows runs natively; WSL is not required. OpenChatX prefers PowerShell 7 (`pwsh.exe`) and falls back to Windows PowerShell (`powershell.exe`) when `pwsh` is unavailable. The vendored `apply_patch` binary is currently macOS-only; on Windows the normal `file_read` / `file_edit` / `file_write` workflow remains available.

Computer Use is intentionally kept outside the core runtime and can be connected as an external MCP.

## Quick start

### Install with a coding agent

Use the bundled install skill:

[`skills/install-openchatx-mcp/SKILL.md`](skills/install-openchatx-mcp/SKILL.md)

### Manual install

Start with the repository. Do not run the full setup yet because it validates the Secure MCP Tunnel prerequisites.

macOS:

```bash
brew install ripgrep
git clone https://github.com/XiaoPuOuO/openchatx-mcp.git
cd openchatx-mcp
npm ci
npm run setup -- --config-only
```

Windows PowerShell:

```powershell
winget install BurntSushi.ripgrep.MSVC
git clone https://github.com/XiaoPuOuO/openchatx-mcp.git
Set-Location openchatx-mcp
npm ci
npm run setup -- --config-only
```

Run the first setup from a normal external terminal (Terminal.app on macOS or PowerShell/Windows Terminal on Windows) so the managed runtime inherits the expected host permissions and environment.

### Set up OpenAI Secure MCP Tunnel

OpenChatX uses OpenAI Secure MCP Tunnel instead of a public reverse proxy. The private MCP server stays on `127.0.0.1:3333`; `tunnel-client` makes the outbound connection to OpenAI.

#### 1. Install `tunnel-client`

Open [OpenAI's Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and use the Platform **Download tunnel-client** button or the [latest `openai/tunnel-client` release](https://github.com/openai/tunnel-client/releases/latest). Always use the latest compatible release instead of a hard-coded version.

On macOS, check your architecture:

```bash
uname -m
```

- `arm64` → download the `darwin-arm64` client.
- `x86_64` → download the `darwin-amd64` client.

After extracting it:

```bash
chmod +x tunnel-client
sudo mv tunnel-client /usr/local/bin/
tunnel-client --help
```

If macOS Gatekeeper says Apple cannot verify `tunnel-client`, first verify that the download came from the official OpenAI release, then remove the quarantine attribute:

```bash
sudo xattr -d com.apple.quarantine /usr/local/bin/tunnel-client
```

On Windows, download the release asset matching your Windows architecture, place `tunnel-client.exe` on `PATH`, then verify:

```powershell
tunnel-client --help
```

#### 2. Start creating the ChatGPT MCP app

Enable **Developer Mode**, open **Plugins**, click **+**, choose **Create app**, then **Create MCP app**.

![Open ChatGPT Settings](docs/assets/enable-developer-mode-step-1.png)

![Enable Developer Mode](docs/assets/enable-developer-mode-step-2.png)

![Create app](docs/assets/create-chatgpt-plugin-step-1.png)

![Create MCP app](docs/assets/create-chatgpt-plugin-step-2.png)

Enter the app name and description, switch the connection type to **Tunnel**, and click **Create tunnel**.

![Choose Tunnel and create a tunnel](docs/assets/secure-tunnel-chatgpt-create.png)

#### 3. Create the tunnel in OpenAI Platform

In the Platform [**Tunnels** settings](https://platform.openai.com/settings/organization/tunnels):

1. Name the tunnel `openchatx`.
2. Add a short description such as `openchatx tunnel`.
3. Select the Platform organization that owns the tunnel.
4. Select the ChatGPT workspace that will use OpenChatX.
5. Click **Create**.

![Create the OpenChatX tunnel](docs/assets/secure-tunnel-platform-create.png)

Copy the resulting `tunnel_...` ID. It is not the API key.

#### 4. Create a runtime API key

Open the Platform [**API keys** page](https://platform.openai.com/settings/organization/api-keys) and create a new secret key for the runtime. A name such as `OpenChatX Runtime Key` makes it easy to identify later. Choose an expiration that matches your security policy; the screenshot uses **Never** for a persistent local runtime. The default **All** permissions are the simplest setup, or use a restricted key if your organization has a defined policy for tunnel access.

![Create the OpenChatX runtime API key](docs/assets/secure-tunnel-runtime-key.png)

Store the secret key securely when it is shown. Do not paste it into chat, commit it to Git, or put it in this repository.

Set it in the same terminal that will run setup/start:

macOS:

```bash
export CONTROL_PLANE_API_KEY="<your-runtime-api-key>"
```

Windows PowerShell:

```powershell
$env:CONTROL_PLANE_API_KEY="<your-runtime-api-key>"
```

OpenChatX intentionally does not load a repository `.env` file. After a reboot or a new shell, export the key again or provide it through your own secure environment/secret manager before starting OpenChatX.

#### 5. Initialize the OpenChatX tunnel profile

Replace `<tunnel_id>` with the ID created above:

```bash
tunnel-client init \
  --profile openchatx \
  --tunnel-id <tunnel_id> \
  --mcp-server-url http://127.0.0.1:3333/mcp
```

If `tunnel-client` says the `openchatx` profile already exists, keep the existing profile when it points at the correct tunnel. Use `--force` only when you intentionally want to replace that profile.

The OpenChatX config defaults to the same profile:

```toml
[tunnel]
profile = "openchatx"
health_port = 8080
```

Now finish OpenChatX setup and start the managed services:

```bash
npm run setup
npm start
```

`npm start` manages both `openchatx-mcp` and `openchatx-tunnel` through the project-local PM2 daemon. You do not need to keep a separate manual `tunnel-client run` terminal open.

#### 6. Verify the tunnel

```bash
tunnel-client doctor --profile openchatx --explain
curl -fsS http://127.0.0.1:3333/healthz
curl -fsS http://127.0.0.1:8080/readyz
npm run status
npm run print-url
```

`doctor` should end with `RESULT ok`. The tunnel operator UI is available at:

```text
http://127.0.0.1:8080/ui
```

#### 7. Finish the ChatGPT MCP app

Return to the ChatGPT MCP app dialog:

1. Select the newly created `openchatx (tunnel_...)` tunnel.
2. Set authentication to **No authentication**.
3. Read and accept the custom MCP risk acknowledgement.
4. Click **Create**.

![Select the tunnel and create the OpenChatX app](docs/assets/secure-tunnel-chatgpt-finish.png)

If desired, set the OpenChatX plugin permission to **Allow all tools**.

![Allow all OpenChatX tools](docs/assets/openchatx-allow-all-tools.png)

> [!IMPORTANT]
> Keep `openchatx-tunnel` running whenever ChatGPT needs to discover or call OpenChatX tools. The first trusted remote tool call binds this installation to that ChatGPT subject. Run `npm run auth:reset` only when you intentionally want to clear that binding.

### Verify

```bash
npm run status
curl -fsS http://127.0.0.1:3333/healthz
curl -fsS http://127.0.0.1:8080/readyz
npm run print-url
```

`npm run print-url` should report the local MCP target, the configured tunnel profile, the tunnel-client UI, and the OpenChatX UI.

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

Want to connect Blender, browser automation, another local app, or a remote MCP server? Just ask ChatGPT to connect it for you.

For example:

> Add this MCP server to OpenChatX and verify that it works.

ChatGPT can inspect the server's setup instructions, configure it through OpenChatX, and verify the connection. You can also manage MCP servers manually from the Dashboard if you prefer.

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
- `subagent_route` / `subagent_route_run` — choose a profile automatically using tags, locality, context size, and cost tier.
- `provider_presets` / `provider_install` / `provider_probe` — configure and verify Provider Hub entries.

## Platform primitives

OpenChatX adds platform-level primitives on top of ordinary tools:

- **Durable Jobs** — `job_start`, `job_list`, `job_read`, `job_cancel`.
- **Projects** — `project_manage` registers an existing absolute path and its read/write/shell scope; OpenChatX never moves the project.
- **Agent Teams** — `agent_team_manage` combines curated model profiles; `agent_team_run` runs members in parallel and returns separate work products to ChatGPT.
- **Capability Composer** — `workflow_manage` creates sequential workflows from lazy MCP/Toolbox tools, subagents, teams, and durable jobs. Step templates can use `{{input}}` and `{{steps.<id>}}`.
- **Capability Store** — built-ins stay local, while Community discovery searches public GitHub repositories tagged `openchatx-capability`; `store_source_tree`, `store_source_read`, and `store_review` expose the exact source revision before `store_install`. Community packages install from an immutable commit SHA and Store uninstall only removes Store-owned Toolbox directories.
- **Nodes** — `node_manage`, `node_probe`, `node_tool_search`, and `node_tool_call` connect other OpenChatX machines.
- **Capability health** — `capability_health` reports runtime, tunnel, MCP, Toolbox, and Provider status.

Persistent definitions live under `state_dir` (default `~/.openchatx-mcp`), including projects, jobs, teams, workflows, nodes, and Store ownership state.

### Publish a Community capability without an OpenChatX Store server

Community publishing is GitHub-native. Put the capability in a public repository, keep `capability.json` at the repository root, and add the repository topic `openchatx-capability`. OpenChatX discovers it directly through the GitHub API; there is no OpenChatX upload server, account system, or package database.

Example `capability.json`:

```json
{
  "schema_version": 1,
  "name": "Game Server Tools",
  "description": "Manage my game server",
  "tags": ["server", "deploy"],
  "toolbox_path": ".",
  "permissions": {
    "shell": true,
    "network": true,
    "filesystem": false,
    "secrets": true
  }
}
```

Run `store_publish_check` on the local directory before publishing. Community capabilities are not reviewed or endorsed by OpenChatX. The Dashboard can show the repository source tree inline, run static analysis, copy an Agent review prompt, and install the exact commit SHA that was inspected. Set `GITHUB_TOKEN` optionally if you need a higher GitHub API rate limit.

## Custom tools

Need a tool that OpenChatX does not have yet? Ask ChatGPT to build it for you.

For example:

> Create an OpenChatX tool that starts my game server and returns its status.

or:

> Make a tool that talks to my local API and lets you query projects.

ChatGPT can create the toolbox, write the TypeScript tool, test it, and make it available to future conversations. You do not need to hand-write plugin files or schemas yourself.

Custom tools stay lazily discoverable through OpenChatX, so adding your own tools does not bloat the normal ChatGPT tool context. The Dashboard is still available when you want to enable, disable, or inspect them manually.

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
.openchatx/config.toml   # runtime, state directory, shell, tunnel-client, MCP output
mcp-servers.json        # external MCP servers
subagents.json          # providers and curated model profiles
toolboxes/              # built-in and custom toolboxes
```

OpenChatX uses the `tunnel-client` profile configured under `[tunnel]`. The default profile is `openchatx`, and the default tunnel admin UI is `http://127.0.0.1:8080/ui`.

Persistent OpenChatX state lives under `state_dir` (default `~/.openchatx-mcp`). Setup creates `~/.openchatx-mcp/AGENTS.md` and `~/.openchatx-mcp/skills/` there without overwriting existing user content. OpenChatX no longer creates a separate agent workspace; relative shell/file/search/image paths start from the current user's home directory unless an absolute path is supplied.

The OpenChatX Dashboard is always available at `/ui`.

## Operations

| Command | Purpose |
| --- | --- |
| `npm start` | Build and start/reload OpenChatX and tunnel-client |
| `npm run desktop:install` | Install a local OpenChatX launcher for macOS or Windows |
| `npm run desktop:uninstall` | Remove the local OpenChatX launcher |
| `npm run update` | Fast-forward a clean checkout to `origin/main`, reinstall dependencies, and rebuild |
| `npm run restart` | Rebuild and reload services |
| `npm run restart -- --hard` | Rebuild and recreate the dedicated PM2 daemon from an external terminal |
| `npm run status` | Show service status |
| `npm run logs` | Show service logs |
| `npm run print-url` | Print the local MCP target, tunnel profile/UI, and OpenChatX UI |
| `npm run stop` | Stop OpenChatX and tunnel-client |
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
