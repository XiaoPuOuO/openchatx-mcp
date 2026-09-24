<p align="center">
  <img src="ui/public/openchatx-mcp-icon.png" width="96" alt="openchatx-mcp icon">
</p>

<h1 align="center">openchatx-mcp</h1>

<p align="center">
  <strong>English</strong> · <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  A local MCP platform for ChatGPT with persistent tools, toolboxes, skills, and local/remote MCP aggregation.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="macOS">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#operations">Operations</a> ·
  <a href="#security">Security</a> ·
  <a href="wiki/">Maintainer wiki</a>
</p>

> [!CAUTION]
> openchatx-mcp runs with the full permissions of your local macOS user. An authorized ChatGPT caller can run commands, edit files, fetch webpages, and control supported applications.

![openchatx-mcp architecture](docs/assets/openchatx-mcp-architecture.png)

## Capabilities

| Capability           | Description                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Persistent shells    | Named login shells retain cwd, environment, processes, and command history across MCP calls. |
| Native `apply_patch` | Native ChatGPT `apply_patch` binary used to edit files independently of shell state.         |
| MCP aggregation      | Local stdio and remote HTTP MCP servers are namespaced and republished through openchatx-mcp. |
| Toolboxes             | Folder-backed plugins containing built-in or user-authored TypeScript tools and skills.       |
| Web and images       | Rendered webpage extraction, bounded document pagination, and native image transport.        |
| Dynamic skills       | Reusable workflows loaded from `<workspace>/skills/*/SKILL.md`.                              |

## Requirements

- macOS on Apple Silicon or Intel
- Node.js 22.18.0 or newer
- npm
- An [ngrok](https://ngrok.com/) account and CLI
- A ChatGPT Plus or Higher account with Developer Mode turned on

Computer Use is intentionally provided through an external MCP rather than being built in.

## Quick start

### Install with your coding agent

[`skills/install-openchatx-mcp/SKILL.md`](skills/install-openchatx-mcp/SKILL.md)

### Manual install

> [!TIP]
> The manual install process should be ran from Terminal.app for the best macOS permission context.

1. Install ngrok, clone the repository, and install dependencies:

   ```bash
   brew install --cask ngrok
   git clone https://github.com/XiaoPuOuO/openchatx-mcp.git
   cd openchatx-mcp
   npm ci
   ```

2. Authenticate ngrok:

   ```bash
   ngrok config add-authtoken <your-token>
   ```

   Get an authtoken from the [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken) if needed.

3. Create the active openchatx-mcp config:

   ```bash
   npm run setup -- --config-only
   ```

   Review `.openchatx/config.toml` and edit any values you want to customize. The generated file shows every supported setting: defaults are active, and settings without defaults are commented examples.

4. Run guided setup:

   ```bash
   npm run setup
   ```

   Setup checks the machine, prepares the workspace, and builds openchatx-mcp.

5. Run the first managed start from Terminal.app:

   ```bash
   npm start
   ```

   This creates or reuses the repository-local PM2 runtime, starts openchatx-mcp and ngrok, waits for local health, and prints the public `/mcp` URL.

6. Enable ChatGPT Developer Mode, then create a custom MCP app with the printed `https://.../mcp` URL and select **No Auth**.

   To enable Developer Mode:

   1. Open your profile menu in the lower-left corner and choose **Settings**.

      ![Open ChatGPT Settings from the profile menu](docs/assets/enable-developer-mode-step-1.png)

   2. In **Security & sign-in**, turn on **Developer Mode**.

      ![Enable Developer Mode in Security & sign-in settings](docs/assets/enable-developer-mode-step-2.png)

   Then create the MCP app:

   1. Open **Plugins** from the left sidebar, click the **+** button, and choose **Create app**.

      ![Open Plugins and choose Create app](docs/assets/create-chatgpt-plugin-step-1.png)

   2. In the plugin upload dialog, choose **Create MCP app**.

      ![Choose Create MCP app](docs/assets/create-chatgpt-plugin-step-2.png)

   3. Fill in the app details:
      - Name: `OpenChatX`
      - Description: for example `OpenChatX for Computer Agent`
      - Server URL: the `https://.../mcp` URL printed by `npm run print-url`
      - Authentication: **No Auth**
      - Confirm that you understand the risks of a custom MCP server, then click **Create**.

      ![Fill in the OpenChatX MCP app settings and create the app](docs/assets/create-chatgpt-plugin-step-3.png)

   4. Open the OpenChatX plugin permissions and select **Allow all tools** so ChatGPT can use openchatx-mcp without prompting before every tool call.

      ![Set OpenChatX plugin permissions to Allow all tools](docs/assets/openchatx-allow-all-tools.png)

> [!IMPORTANT]
> The first trusted remote tool call binds the installation to that ChatGPT subject. Use `npm run auth:reset` only when you intend to clear that binding.

### Verify the installation

```bash
npm run status
curl -fsS http://127.0.0.1:3333/healthz
npm run print-url
```

The default local MCP endpoint is `http://127.0.0.1:3333/mcp`; root `port` in `.openchatx/config.toml` changes the listener and health-check port.

## External MCP servers

Copy `mcp-servers.example.json` to the gitignored `mcp-servers.json`. Each enabled entry is connected at openchatx-mcp startup and its tools are exposed through the same ChatGPT MCP connection. Local entries use stdio; remote entries use Streamable HTTP. Tool names are namespaced as `<server>__<tool>` so different MCP servers cannot collide.

```json
{
  "open-computer-use": {
    "type": "local",
    "command": ["/opt/homebrew/bin/open-computer-use", "mcp"],
    "enabled": true
  },
  "unreal-engine": {
    "type": "remote",
    "url": "http://127.0.0.1:8000/mcp",
    "enabled": true,
    "timeout": 300000
  }
}
```

Unavailable MCP servers do not prevent openchatx-mcp from starting. External MCP tools stay lazy: their full schemas are not added to ChatGPT's main tool list. Instead, `start_here` returns a lightweight capability catalog containing each configured server's id/name, description, availability, and tool count. This lets ChatGPT know that capabilities such as Blender or Unreal Engine exist without paying the schema cost of every underlying tool. When a capability fits the task, ChatGPT can call `tool_search` with `source="mcp"` and an optional `server="<id>"`, then invoke the selected result through `tool_call`. Restart openchatx-mcp after an unavailable server becomes available so its tools can be discovered.

## Provider-backed subagents

Subagents run through providers configured by openchatx-mcp itself. They do not automate additional ChatGPT conversations. This makes local GPU inference, self-hosted models, and external APIs available as delegated workers while ChatGPT remains the primary planner.

Providers do **not** automatically expose every model they offer. The user explicitly creates curated model profiles with a name, description, real provider model ID, context window, optional max output, and thinking configuration. ChatGPT sees only those profiles and uses their descriptions to choose the right worker.

Configure them from the dashboard's **Subagents** page or copy [`subagents.example.json`](subagents.example.json) to the gitignored `subagents.json`.

```json
{
  "providers": {
    "local-vllm": {
      "type": "openai-compatible",
      "base_url": "http://127.0.0.1:8000/v1",
      "enabled": true,
      "timeout": 120000
    }
  },
  "models": {
    "qwen-fast": {
      "provider": "local-vllm",
      "model": "Qwen3.8-Flash-Next",
      "name": "Qwen3.8-Flash-Next",
      "description": "Fast model for simple, high-volume mechanical work.",
      "enabled": true,
      "context_window": 131072,
      "thinking": {
        "mode": "boolean",
        "request_field": "enable_thinking",
        "default_enabled": false
      }
    }
  }
}
```

`max_output_tokens` is optional. If neither the model profile nor `subagent_run` supplies a maximum, openchatx-mcp leaves the provider's output limit unspecified.

The initial provider adapter supports OpenAI-compatible `/chat/completions` endpoints, including common local inference servers. Additional provider adapters can be added without changing the curated profile model.

Agent-facing tools remain intentionally small:

- `subagent_list` — lists configured model profiles and their intended uses.
- `subagent_run` — delegates one task to one selected profile.

## Toolboxes and custom TypeScript tools

Every built-in tool is assigned to a toolbox, and user toolboxes use the same runtime. A toolbox is a folder under `toolboxes/`:

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

The dashboard's **Toolboxes** page can enable or disable whole toolboxes, individual tools, and skills. It can also create toolbox folders, TypeScript tool templates, and skill templates. Built-in Shell/File/Web/Media tools are managed from the same page rather than from `[tools]` in the TOML config.

Custom tools use the public toolbox SDK:

```ts
import { defineTool, z } from "openchatx-mcp/toolbox"

export default defineTool({
  name: "hello",
  description: "Say hello",
  inputSchema: z.object({ name: z.string() }),
  async execute({ name }) {
    return { content: [{ type: "text", text: `Hello ${name}` }] }
  },
})
```

The tool name must match its `.ts` filename. User tools are exposed as `<toolbox>__<tool>` to prevent collisions. `Tool` subclasses may additionally provide `title`, `outputSchema`, MCP annotations/icons/metadata, `required`, and `onLoad` / `onUnload` lifecycle hooks. Changes under `toolboxes/` are watched and reloaded without restarting the openchatx-mcp process; a connected MCP client may need to refresh its advertised tool list after schemas change.

## Optional capabilities

## Operations

| Command                | Purpose                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `npm start`            | Build and start or reload openchatx-mcp, ngrok, and enabled supporting services. |
| `npm run restart`      | Rebuild, clear the audit log, and reload services using the existing PM2 daemon. |
| `npm run restart -- --hard` | Rebuild and recreate openchatx-mcp's PM2 daemon from a healthy Terminal.app session. |
| `npm run status`       | Show PM2 process state.                                                        |
| `npm run logs`         | Follow PM2 logs.                                                               |
| `npm run pm2 -- <args>` | Run a PM2 command against openchatx-mcp's dedicated daemon.                    |
| `npm run print-url`    | Print the active public `/mcp` URL.                                            |
| `npm run stop`         | Stop the managed openchatx-mcp and ngrok processes.                            |
| `npm run auth:reset`   | Clear the bound remote ChatGPT subject after confirmation.                     |

PM2 is installed as a repository dependency. openchatx-mcp uses `<state_dir>/pm2` for its daemon, sockets, logs, and process state. This is separate from the default `~/.pm2` daemon used by other projects.

Use `npm run restart` for routine code or config changes, including from `bash`. It keeps the PM2 daemon, reloads ngrok, then reloads MCP. The initiating MCP connection may close; after services return, make a fresh tool call. Build failures leave running services and the audit log intact.

For macOS permission or service-context problems, run `npm run restart -- --hard` from a healthy Terminal.app session. This recreates openchatx-mcp's dedicated PM2 daemon. Hard restart refuses to run from inside openchatx-mcp because stopping that daemon would kill the command responsible for starting its replacement.

If an older installation was previously running under the default shared daemon, move it once from Terminal.app before using the new commands:

```sh
PM2_HOME="$HOME/.pm2" ./node_modules/.bin/pm2 delete shellby-mcp shellby-ngrok
npm run restart
```

The first command removes only the legacy app entries, leaving the shared daemon and other projects running. If an older installation still has a `shellby-cursor-host` entry in that daemon, delete that entry there too. The migration briefly interrupts the MCP service; it does not erase authentication state. Future restarts need only `npm run restart`.

### Update an existing installation

```bash
git pull
npm ci
npm run setup -- --config-only
npm start
```

## Configuration

openchatx-mcp's public configuration is the gitignored `.openchatx/config.toml`. `npm run setup` creates a config showing every supported setting for new installations, with defaults active and the optional `ngrok.url` shown as a commented example. Set `ngrok.url` to your assigned or reserved static ngrok domain so the ChatGPT connector URL stays unchanged across PM2/ngrok restarts; leaving it commented lets ngrok choose the public endpoint. Existing files are left untouched, preserving their values, comments, and formatting. Missing settings use defaults automatically. Invalid values produce a warning and fall back individually; unknown keys warn and are ignored. Valid TOML formatting—including reordered sections, dotted keys, and inline tables—is accepted. Malformed TOML syntax still needs correction; errors show the location and never rewrite your file.

The TOML surface owns runtime state, workspace, shell, ngrok, and MCP-output settings. The local dashboard is always enabled at `/ui`. External MCP servers are configured separately in `mcp-servers.json`, while built-in and user-authored tools are managed through `toolboxes/` and the Toolboxes UI. `state_dir` controls machine-local authentication and PM2 state and defaults to `~/.openchatx-mcp`. Authentication state is OpenChatX-native and is never imported from legacy Shellby state. `start_here` is always published as a required system tool.

```toml
state_dir = "~/.openchatx-mcp"
workspace = "~/Desktop/agent-workspace"

[shell]
path = "/bin/zsh"
rtk = false

[mcp]
tool_output = "compact"

```

`mcp.tool_output` controls the representation used for ordinary built-in tool results. `compact` is optimized for model context and omits public output schemas; `structured` preserves each tool's structured result and output schema for MCP clients that use them. External MCP results are proxied without compacting so image/audio/resource content is preserved. Changing this setting requires an openchatx-mcp restart.

`shell.rtk` defaults to `false`, so RTK is not required. To enable transparent RTK command rewriting, install RTK Token Killer with `brew install rtk`, set `shell.rtk = true`, and restart openchatx-mcp. The runtime resolves that executable from startup `PATH`, then uses the resolved absolute path for supported rewrites regardless of the shell command's cwd. Unsupported rewrites and RTK failures fall back to the original command. Caller-visible command identity remains based on the original command.

openchatx-mcp does not use a repository `.env` file. Runtime settings live in `.openchatx/config.toml`; external MCP servers live in `mcp-servers.json`; toolboxes live in `toolboxes/`. ngrok is resolved from `PATH` and authentication is configured with `ngrok config add-authtoken`. The loopback host and internal runtime limits remain code-owned in [`src/config.ts`](src/config.ts).

### Running two copies

Give each repository copy its own state directory and MCP port. Copies using ngrok also need separate ngrok API ports and public URLs. Changing only `state_dir` separates saved state and PM2, but does not prevent port collisions. In the second copy's `.openchatx/config.toml`, merge these values into the existing root and sections:

```toml
state_dir = "~/.openchatx-mcp-second"
port = 3334

[ngrok]
api_port = 4041
url = "https://your-second-reserved-domain.ngrok.app"
pooling_enabled = false

```

Use a real, distinct ngrok URL available to your account. Keep pooling disabled for independent copies. If your config is missing, run `npm run setup -- --config-only` first, then edit it before full setup or startup. Run `npm run setup` in the new copy, then run `npm start` from Terminal.app. Run `npm run print-url` in each repository to get that copy's connector URL.

Each copy's PM2 commands, including hard restart, target its configured state directory. Authentication state stays separate. ngrok credentials remain in its native user config; openchatx-mcp writes only an API-address overlay at `<state_dir>/ngrok-agent.json`. The dashboard uses the copy's MCP port (`http://127.0.0.1:3334/ui/` for this example); the Vite development proxy also reads that port. Workspace files and the macOS desktop are still shared unless you select a separate `workspace`.

### Local-only MCP

To run without ngrok, add or update this setting in `.openchatx/config.toml`:

```toml
[ngrok]
enabled = false
```

Then use the usual `npm start` or `npm run restart`. PM2 and the dashboard still work. Setup and preflight skip ngrok installation/authentication checks. Startup removes any existing `openchatx-ngrok` process from this instance's PM2 daemon before reloading MCP; a cleanup failure stops startup. Separately managed tunnels are outside this setting's scope.

`npm run print-url` prints `http://127.0.0.1:<port>/mcp` for your local MCP client. A new installation can run `npm run setup -- --config-only`, set `ngrok.enabled = false`, then run full setup without installing ngrok. The setting defaults to `true`, so existing configurations retain their behavior. Reserved URL and pooling values remain saved for later re-enabling. Local-only copies do not need a separate ngrok API port or public URL.

## Troubleshooting

If the endpoint stays offline after restarting, check `npm run status` and `npm run logs` from Terminal.app. Run `npm start` if services are stopped. `npm run print-url` reports the active ngrok endpoint; an offline reserved URL does not by itself mean your config changed. Routine restart through `bash` may disconnect its own call while PM2 brings MCP back.

<details>
<summary><strong>Setup or startup fails</strong></summary>

Run:

```bash
npm run preflight
npm run status
npm run logs
```

`preflight` checks the supported macOS/Node environment, local dependencies, ngrok installation, and ngrok authentication. If `/healthz` does not become available after startup, inspect PM2 status and logs first.

</details>

<details>
<summary><strong>The PM2 daemon needs to be recreated</strong></summary>

Run `npm run restart -- --hard` from a newly opened Terminal.app session. This recreates openchatx-mcp's dedicated PM2 daemon as well as the MCP process and ngrok. Ordinary restart retains the daemon's inherited macOS session and cannot repair a stale service context.

</details>

More startup and recovery details are in [Configuration and Startup](wiki/pages/operations/configuration-and-startup.md).

## Security

- The checked-in ngrok traffic policy exposes the local MCP endpoint to ChatGPT.
- Direct localhost MCP access is unauthenticated. Do not expose the local endpoint through another untrusted proxy.
- Trusted remote tool calls are bound to the first ChatGPT subject stored in `<state_dir>/auth.json`.
- The dedicated authenticated Chrome profile is part of the trust boundary for browser subagents.
- `agent-commands.yaml` can contain sensitive tool inputs. It is gitignored and permission-restricted and should be treated as private.

See [SECURITY.md](SECURITY.md) for reporting and scope.

## Development

```bash
npm run dev
npm run ui:dev
npm run lint
npm run typecheck
npm test
npm run build
npm run ui:build
```

Run `npm run ui:install` once after cloning to install the dashboard dependencies. Use `npm run inspect` for the MCP inspector and `npm run schemas` to print the published tool schemas. Authenticated browser tests are excluded from CI. See [Build and Test](wiki/pages/operations/build-and-test.md).

## Documentation

The [maintainer wiki](wiki/) contains implementation and operational details:

- [Project Overview](wiki/pages/project-overview.md)
- [Architecture Map](wiki/pages/architecture-map.md)
- [Configuration and Startup](wiki/pages/operations/configuration-and-startup.md)
- [MCP Tool Surface](wiki/pages/mcp-tool-surface.md)
- [Build and Test](wiki/pages/operations/build-and-test.md)
- [Open Questions and Risks](wiki/pages/project/open-questions-and-risks.md)

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Run the development validation commands above for code changes.

## License

[MIT](LICENSE). The vendored `apply_patch` binary retains its upstream OpenAI Codex license and notices under [`vendor/apply-patch/`](vendor/apply-patch/).

## Attribution

Parts of this project are derived from [Shellby MCP](https://github.com/Serbyte-Development/shellby-mcp), originally created by Serbyte Development under the MIT License. The original license notice is preserved in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
