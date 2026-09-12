---
summary: "Configuration ownership and startup composition across workspace bootstrap, managed runtime, shutdown, and recovery boundaries."
paths:
  - src/config.ts
  - src/public-config.cts
  - src/index.ts
  - scripts/
  - skills/create-skill/SKILL.md
  - ecosystem.config.cjs
---

# Configuration and Startup

## What This Is

This page maps configuration ownership, workspace bootstrap, managed runtime composition, process lifecycle, and failure boundaries to their implementation sources.

## Static MCP Configuration

`src/public-config.cts` owns the public schema, defaults, and TOML loader. `src/config.ts` loads the repo-local `.shellby/config.toml` through it and exports process-wide `MCP_CONFIG`. Missing settings use defaults silently. Invalid values warn with their field path and fall back individually; unknown keys warn and are ignored. Valid sibling values, including disabled tool groups, survive normalization. Invalid sections use that section’s defaults. Pooling without a valid ngrok URL warns and disables pooling. `npm run setup -- --config-only` creates a config showing every supported setting for new installations, with defaults active and the optional `ngrok.url` as a commented example. Later setup runs leave existing files untouched, including partial configs, comments, and formatting; runtime supplies omitted defaults without a migration. Full `npm run setup` follows the same create-only behavior before loading runtime config. The local file remains gitignored. Model-facing text response limits use `o200k_base` tokens; internal retention, cache, record, wait, and shutdown limits stay literal code-owned values. The delegated-ID admission limit is separately public, as described below. `buildMcpInstructions()` supplies minimal global routing instructions. `start_here` loads shared and mode-specific prompt files; it does not interpolate the configured workspace or automatically read its `AGENTS.md` (`src/config.ts`, `src/public-config.cts`, `scripts/setup.mjs`, `scripts/workspace-setup.mjs`).

Public TOML fields are intentionally small: root `workspace`; `shell.path` and `shell.rtk`; `chatgpt.cdp_endpoint`, `chatgpt.project_url`, and `chatgpt.max_delegated_agents`; `mcp.tool_output` (`compact` or `structured`); `ui.enabled`; `ngrok.url` and `ngrok.pooling_enabled`; and the `review`, `shell`, `apply_patch`, `clones`, `subagents`, `web`, `skills`, `image`, and `computer` booleans under `[tools]`. The setup-generated config enables every tool group, defaults `shell.rtk` to `false`, defaults MCP tool output to `compact`, and leaves the UI and ngrok pooling disabled. `chatgpt.max_delegated_agents` defaults to `3`, accepts positive integers, and caps delegated IDs per main-agent session across subagents and clones, including saved mappings and in-flight creations. Existing IDs remain reusable when the limit is reached or lowered. RTK is optional. When enabled, Shellby resolves `rtk` once from startup `PATH`, validates the RTK Token Killer `rewrite` interface during setup/startup, and transparently rewrites supported shell commands immediately before execution; unsupported rewrites fail open to the exact original command. `compact` removes ordinary public output schemas and projects results through Shellby's compact formatter; `structured` preserves the tools' native structured results and output schemas. Computer Use and `image_view` keep native MCP content in either mode. `start_here` is always enabled. Public config changes require a Shellby restart (`src/config.ts`, `src/tools/shell/rtk.ts`, `scripts/preflight.mjs`, `src/server/mcp-server.ts`, `src/server/tool-registration-boundary.ts`).

Valid TOML syntax is independent of template layout: comments, whitespace, reordered sections, dotted keys, quoted keys, and inline tables pass through the TOML parser before validation. Keys remain case-sensitive. Setup never reformats existing files. A missing file still directs the operator to setup; unreadable files and malformed TOML remain errors. Syntax diagnostics include the parser's numbered location. Never replace an unparseable file with global defaults, since doing so would lose valid operator choices.

The shared module compiles to `dist/public-config.cjs`, allowing PM2's CommonJS ecosystem file to use the same normalized values as the ESM runtime. `scripts/workspace-setup.mjs` imports the source through setup's existing `tsx` loader and derives the new-user scaffold from the schema defaults. Keep those paths synchronized; do not reintroduce raw TOML parsing in the ngrok launcher.

## Configuration Ownership

Shellby does not load a repository `.env` file and does not expose environment-variable overrides for its binaries or browser profile. Shellby user configuration belongs in `.shellby/config.toml`. `ngrok.url` may pin a reserved public endpoint and `ngrok.pooling_enabled` enables ngrok endpoint pooling for that URL; omitting `ngrok.url` preserves ngrok's assigned public URL behavior. ngrok authentication belongs to ngrok's native user configuration and is set with `ngrok config add-authtoken`; the executable is resolved from `PATH`. Chrome is discovered in the normal macOS application locations and uses Shellby's dedicated `~/.shellby/chatgpt-chrome` user-data directory. Computer Use uses the package-local Peekaboo build. RTK is an optional external CLI: when `shell.rtk = true`, its executable is resolved from the Shellby process `PATH`, while RTK's normal filtering/exclusion configuration still applies. Shellby forces RTK's separate failure tee and telemetry off and routes RTK history writes to `/dev/null` so Shellby commands are not duplicated into RTK-local persistence. Shell caller-visible lifetime consequences are in [`shell_run` / `shell_poll`](../tools/shell-run.md); manager mechanics are in [Persistent Shell Runtime](../persistent-shell-runtime.md).

```toml
[ngrok]
url = "https://your-reserved-domain.ngrok.app"
pooling_enabled = true
```

Production HTTP always binds to `127.0.0.1:3333`; host and port are not user-configurable. The configured `workspace` expands `~`, resolves relative values from the repository root, and becomes the shell/workspace/instruction root. Setup creates its `AGENTS.md` as workspace guidance; startup instructions do not automatically load that file. Shell limits and lifetimes remain fixed in `MCP_CONFIG`. Audit retention and token-accounting behavior are documented in [Audit Logging](./audit-logging.md).

## Startup and Shutdown

Public startup is driven by `scripts/start.mjs`. The startup scripts import the same `MCP_CONFIG` used by runtime, so workspace and ChatGPT routing have one interpretation. Startup runs the Mac/ngrok preflight, requires the configured workspace to already exist, builds, starts or reloads the MCP and ngrok through the repository-local PM2 dependency, launches the dedicated ChatGPT Chrome profile only when clone or subagent tools are enabled, waits for `/healthz`, and prints the public `/mcp` URL. `ecosystem.config.cjs` resolves ngrok from the caller's `PATH` and reads normalized config through the compiled shared loader; it does not load repository environment files. For first-time setup, `scripts/setup.mjs` prepares the workspace and runs optional Computer Use or browser setup only for enabled tool groups. Existing workspace instructions and customized starter skills are never overwritten (`package.json`, `src/config.ts`, `scripts/preflight.mjs`, `scripts/setup.mjs`, `scripts/workspace-setup.mjs`, `scripts/start.mjs`, `skills/create-skill/SKILL.md`, `ecosystem.config.cjs`, `test/setup-workspace.test.ts`).

Inside the MCP process, `src/index.ts` is the production composition root. It constructs, starts, and disposes the shell manager, Peekaboo client, cursor host, and browser-backed agent service required by enabled tool groups; it constructs the webpage opener when web tools are enabled. `src/server/http-server.ts` receives those live services and owns only HTTP/MCP transport plus request state. Scalar process configuration is consumed directly from `MCP_CONFIG` rather than forwarded through server option bags. `src/server/mcp-server.ts` conditionally registers each enabled tool group. `apply_patch` resolves its checked-in vendored binary directly in its tool module. Authentication state and best-effort subagent conversation mappings remain under `~/.shellby/` (`src/index.ts`, `src/server/http-server.ts`, `src/server/mcp-server.ts`, `src/tools/apply-patch/apply-patch.ts`).

## Dashboard Build Boundary

`ui.enabled` defaults to `false`. Enabling it composes the observer and serves `ui/dist` from the MCP process. Root `setup`, `build`, and `start` build only the backend; they do not install or build UI dependencies. Use `npm run ui:install` and `npm run ui:build` for production assets, or `npm run ui:dev` for Vite with its API proxy to port 3333. See the [UI wiki](../../../ui/wiki/index.md) and [HTTP Transport](../http-transport.md).

## Peekaboo Permission Integration

Shellby ships its compatible Peekaboo CLI and cursor host under `vendor/peekaboo/`; Peekaboo is not an npm dependency and is not runtime-selectable. The cursor host is resolved beside the bundled executable. `scripts/setup.mjs` requests source-aware permission status through `scripts/peekaboo-permissions.mjs`; `setup:computer` delegates grants to Peekaboo rather than duplicating macOS permission logic. TCC grants attach to the responsible launching process, which is why process ancestry and PM2 launch context matter when debugging permission behavior (`vendor/peekaboo/`, `scripts/peekaboo-permissions.mjs`, `src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).

Maintainers rebuild the checked-in Universal 2 binaries from the local Peekaboo fork with `npm run vendor:peekaboo -- /absolute/path/to/Peekaboo`. The build script records source commit, hashes, toolchain, and target architectures in `vendor/peekaboo/provenance.json` (`scripts/build-peekaboo.sh`).

## Package Scripts

- Runtime check: `preflight` accepts macOS arm64 and x64, then validates Node 22.13.0+, local dependencies, ngrok installation, and ngrok authentication without changing runtime state. `setup -- --config-only` creates `.shellby/config.toml` when absent and checks the effective configuration; full `setup` wraps the runtime checks and workspace/build flow, then checks Peekaboo or Chrome only when their corresponding tool groups are enabled. `setup:computer` and `setup:chatgpt` remain explicit commands for those optional integrations (`scripts/preflight.mjs`, `scripts/setup.mjs`, `scripts/setup-ui.mjs`, `scripts/peekaboo-permissions.mjs`, `scripts/chatgpt-browser.mjs`).
- Production runtime: `start` builds and starts/reloads MCP + ngrok and auto-launches the configured ChatGPT browser only when clone or subagent tools are enabled; `restart` builds, kills the PM2 daemon and its apps, clears the current audit log after shutdown, then starts fresh services. `status`, `logs`, and `stop` expose the small PM2 management surface. Ordinary startup deletes any obsolete PM2 `shellby-cursor-host` app because cursor-host ownership now lives inside the MCP process. PM2 gives the MCP process 10 seconds to complete signal-driven cleanup before forcing termination (`package.json`, `scripts/start.mjs`, `ecosystem.config.cjs`, `src/tools/computer/cursor-host.ts`).
- Development: `dev`, `build`, and `inspect` keep direct local development separate from the managed production runtime.
- Tunnel: the managed PM2 ngrok process exposes port 3333 through the checked-in traffic policy with the local HTTP inspector disabled. When local config supplies `ngrok.url`, startup passes that reserved URL to ngrok and optionally enables pooling. Without it, ngrok assigns the public URL (`ecosystem.config.cjs`, `.shellby/config.toml`).
- URL discovery: `print-url` reads ngrok's local tunnel API and prints the active `https://<domain>/mcp` URL. `start` and `restart` call it after the managed runtime is healthy (`package.json`, `scripts/print-url.mjs`, `scripts/start.mjs`).
- Authentication: `auth:reset` performs the local warning/confirmation flow and clears the bound subject. Reset does not generate or rotate an ngrok URL (`package.json`, `src/auth/reset.ts`).
- Subagent state: `reset-agents` deletes `~/.shellby/subagents.sqlite` plus SQLite sidecars, intentionally forgetting persisted `agent_id` conversation mappings. It does not affect ChatGPT conversations themselves (`package.json`, `scripts/reset-agents.mjs`, `src/tools/subagent/subagent-store.ts`).

Remote trust and subject binding are canonical in [HTTP Transport](../http-transport.md).

Production HTTP, health checks, the PM2 ngrok app, and the trusted Host rewrite deliberately share fixed local port 3333. `src/server/http-server.ts` reads that process-wide value directly from `MCP_CONFIG` (`src/config.ts`, `src/server/http-server.ts`, `scripts/start.mjs`, `package.json`, `ecosystem.config.cjs`, `ngrok-traffic-policy.yml`).

## Failure and Recovery Boundaries

- `restart` recreates the PM2 daemon before starting the MCP and ngrok definitions in `ecosystem.config.cjs`. Build must succeed before shutdown; PM2 shutdown must succeed before audit-log deletion or service startup. The authenticated browser profile is reused (`package.json`, `scripts/start.mjs`, `scripts/chatgpt-browser.mjs`, `ecosystem.config.cjs`, `test/start.test.ts`).
- `MCP server did not become healthy` is emitted only after PM2 returns and the bounded `/healthz` loop fails. It identifies a failed health observation, not the underlying startup cause (`scripts/start.mjs`, `package.json`).
- `scripts/pm2.mjs` is the shared CLI boundary for startup, restart, stop, status, logs, and `npm run pm2 -- <args>`. It sets `PM2_HOME` to `~/.shellby/pm2` even when the caller exports another PM2 home, uses the local package, and resolves ecosystem paths from the repo root. Shellby's daemon, sockets, logs, and process list are isolated from the default `~/.pm2` daemon. The home is per user, consistent with Shellby's fixed port and browser profile; separate checkouts do not get independent runtimes. Installing a local PM2 package alone does not isolate the daemon (`scripts/pm2.mjs`, `scripts/start.mjs`, `package.json`, `test/start.test.ts`).
- Existing installations must remove only the `shellby-mcp` and `shellby-ngrok` entries from the old shared daemon before starting the dedicated runtime; also remove `shellby-cursor-host` there if present. Use `PM2_HOME="$HOME/.pm2" ./node_modules/.bin/pm2 delete shellby-mcp shellby-ngrok`, then `npm run restart` from Terminal.app. No automatic migration touches the shared daemon. Other projects remain running. Authentication and browser state stay in place; see README Operations.
- Run `restart` from a healthy Terminal.app session, outside Shellby. A stale inherited macOS service context can leave MCP reachable while Chromium aborts in `_RegisterApplication` and shell DNS fails. On 2026-09-08, both failures were isolated to PM2 descendants; recreating PM2 from a healthy session restored fetching. Reloading apps preserves the daemon's context. The dedicated home limits daemon resets to Shellby; Terminal-independent lifecycle still requires a macOS LaunchAgent, which startup does not currently install.

## Related

- [Project Overview](../project-overview.md)
- [Architecture Map](../architecture-map.md)
- [HTTP Transport](../http-transport.md)
- [Workspace Tooling](../workspace-tooling.md)
- [Computer Use](../computer-use.md)
- [Build and Test](./build-and-test.md)
- [Open Questions and Risks](../project/open-questions-and-risks.md)
- [Audit Logging](./audit-logging.md)
