---
summary: "Configuration ownership and startup composition across persistent-state bootstrap, managed runtime, shutdown, and recovery boundaries."
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

This page maps configuration ownership, persistent-state bootstrap, managed runtime composition, process lifecycle, and failure boundaries to their implementation sources.

## Static MCP Configuration

`src/public-config.cts` owns the public schema, defaults, and TOML loader. `src/config.ts` loads the repo-local `.openchatx/config.toml` through it and exports process-wide `MCP_CONFIG`. Missing settings use defaults silently. Invalid values warn with their field path and fall back individually; unknown keys warn and are ignored. Valid sibling values survive normalization. Invalid sections use that section’s defaults. `npm run setup -- --config-only` creates a config showing every supported setting for new installations, including the default `state_dir` and `[tunnel]` settings. Later setup runs leave existing files untouched, including partial configs, comments, and formatting; runtime supplies omitted defaults without a migration. Full `npm run setup` follows the same create-only behavior before loading runtime config, then initializes persistent state under `state_dir` via `scripts/state-setup.ts`. There is no separate agent workspace directory.

Public TOML fields are intentionally small: root `state_dir` and `port`; `shell.path` and `shell.rtk`; `tunnel.profile` and `tunnel.health_port`; `mcp.tool_output` (`compact` or `structured`); and the `review`, `shell`, `apply_patch`, `file_read`, `file_write`, `clones`, `subagents`, `web`, `skills`, `image`, and `computer` booleans under `[tools]`. `state_dir` defaults to `~/.openchatx-mcp` and controls machine-local runtime state including authentication, subagent persistence, the managed ChatGPT Chrome profile, and the PM2 daemon. The setup-generated config defaults `shell.rtk` to `false`, MCP tool output to `compact`, and the tunnel profile/health port to `openchatx`/`8080`. `chatgpt.max_delegated_agents` defaults to `3`, accepts positive integers, and caps delegated IDs per main-agent session across subagents and clones, including saved mappings and in-flight creations. Existing IDs remain reusable when the limit is reached or lowered. RTK is optional. When enabled, Shellby resolves `rtk` once from startup `PATH`, validates the RTK Token Killer `rewrite` interface during setup/startup, and transparently rewrites supported shell commands immediately before execution; unsupported rewrites fail open to the exact original command. `compact` removes ordinary public output schemas and projects results through Shellby's compact formatter; `structured` preserves the tools' native structured results and output schemas. Computer Use, `image_view`, and `file_read` keep native MCP content in either mode. `start_here` is always enabled. Public config changes require a Shellby restart (`src/config.ts`, `src/tools/shell/rtk.ts`, `scripts/preflight.ts`, `src/mcp/server-factory.ts`, `src/mcp/tool-registration-boundary.ts`).

Valid TOML syntax is independent of template layout: comments, whitespace, reordered sections, dotted keys, quoted keys, and inline tables pass through the TOML parser before validation. Keys remain case-sensitive. Setup never reformats existing files. A missing file still directs the operator to setup; unreadable files and malformed TOML remain errors. Syntax diagnostics include the parser's numbered location. Never replace an unparseable file with global defaults, since doing so would lose valid operator choices.

The shared module compiles to `dist/public-config.cjs`, allowing PM2's CommonJS ecosystem file to use the same normalized values as the ESM runtime. `scripts/state-setup.ts` imports the source through setup's existing `tsx` loader, derives the new-user config scaffold from schema defaults, and creates persistent `AGENTS.md`/skills under `state_dir`. Keep those paths synchronized; the PM2 ecosystem consumes the same compiled config and launches `tunnel-client` from the normalized tunnel settings.

## Configuration Ownership

OpenChatX does not load a repository `.env` file. User configuration belongs in `.openchatx/config.toml`. `state_dir` is the configurable root for machine-local OpenChatX state and defaults to `~/.openchatx-mcp`; separate installations can use different values for runtime isolation. The Secure MCP Tunnel profile is selected by `tunnel.profile` (default `openchatx`), its local health/admin port is `tunnel.health_port` (default `8080`), and `tunnel-client` is resolved from `PATH`. Tunnel authentication comes from `CONTROL_PLANE_API_KEY` (or the supported `OPENAI_API_KEY` fallback) in the environment that starts the managed runtime. Chrome is discovered in the normal macOS application locations and uses `<state_dir>/chatgpt-chrome` as its managed user-data directory. Computer Use uses the package-local Peekaboo build. RTK is an optional external CLI: when `shell.rtk = true`, its executable is resolved from the Shellby process `PATH`, while RTK's normal filtering/exclusion configuration still applies. Shellby forces RTK's separate failure tee and telemetry off and routes RTK history writes to `/dev/null` so Shellby commands are not duplicated into RTK-local persistence. Shell caller-visible lifetime consequences are in [`shell_run` / `shell_poll`](../tools/shell-run.md); manager mechanics are in [Persistent Shell Runtime](../persistent-shell-runtime.md).

```toml
[tunnel]
profile = "openchatx"
health_port = 8080
```

Production HTTP binds to loopback `127.0.0.1` at the configured root `port` (default `3333`). `tunnel-client` exposes its local health/admin surface on `tunnel.health_port` (default `8080`). Both port settings accept integers from 1 through 65535. `state_dir` defaults to `~/.openchatx-mcp`; setup creates `<state_dir>/AGENTS.md` and `<state_dir>/skills/` without overwriting existing user content. Relative shell/file/search/image paths resolve from the operating-system user's home directory through `MCP_CONFIG.defaultCwd`. There is no separate workspace directory.

## Secure MCP Tunnel Runtime

OpenChatX supports OpenAI `tunnel-client` as its managed remote transport. Setup and preflight require the executable, the configured profile, and tunnel authentication in the startup environment. The PM2 ecosystem always manages `openchatx-tunnel`; there is no ngrok or local-only transport mode in the managed production lifecycle.

Ordinary start/restart reloads `openchatx-tunnel` before `openchatx-mcp`. That ordering is intentional: restarting MCP from an OpenChatX-owned shell can terminate the requesting process, so all tunnel lifecycle work must complete first. Hard restart recreates the dedicated PM2 daemon and then starts both managed apps (`scripts/start.ts`, `scripts/setup.ts`, `scripts/preflight.ts`, `ecosystem.config.cjs`, `test/start.test.ts`, `test/preflight.test.ts`).

## Concurrent Repository Copies

`state_dir` isolates saved runtime state, AGENTS.md, reusable skills, and the PM2 daemon. Running copied repositories simultaneously also requires distinct root `port`, distinct `tunnel.health_port`, and separate tunnel-client profiles/tunnel IDs. Relative local-tool paths still default to the same operating-system home directory unless callers provide absolute paths.

`ecosystem.config.cjs` resolves `tunnel-client` from `PATH` and starts the configured profile with the configured loopback health address. `print-url` reports the local MCP target plus the tunnel profile and operator UI rather than discovering a public URL. Startup's health check verifies an instance header derived from the repository and resolved state root, preventing a different copy from producing a false success. Startup's health check verifies an instance header derived from the repository and resolved state root, preventing a different copy from producing a false success (`ecosystem.config.cjs`, `scripts/print-url.ts`, `test/instance-isolation.test.ts`, `test/start.test.ts`).

## Startup and Shutdown

Public startup is driven by `scripts/start.ts`. Startup runs preflight, including tunnel-client/profile/authentication checks, builds, then starts or reloads the managed tunnel before MCP through the repository-local PM2 dependency. It no longer checks or creates a separate workspace directory. First-time `npm run setup` prepares `state_dir`, including `AGENTS.md` and the starter skill, while preserving existing user content (`scripts/setup.ts`, `scripts/state-setup.ts`, `scripts/start.ts`, `test/state-setup.test.ts`).

Inside the MCP process, `src/index.ts` is the production composition root. It constructs, starts, and disposes the shell manager, Peekaboo client, cursor host, and browser-backed agent service required by enabled tool groups; it constructs the webpage opener when web tools are enabled. `src/mcp/server-factory.ts` binds those capability services and snapshots server identity, enabled tool groups, and tool-output mode into an immutable process-level factory profile. `src/server/http-server.ts` receives that factory plus transport-owned auth/audit state and the optional observer; the observer is supplied once there and shared by MCP tool observation and dashboard routes. HTTP listener configuration remains process-wide in `MCP_CONFIG`. `apply_patch` resolves its checked-in vendored binary directly in its tool module. Authentication state and best-effort delegated-conversation mappings live under the configured `state_dir` (`src/index.ts`, `src/server/http-server.ts`, `src/mcp/server-factory.ts`, `src/tools/apply-patch/apply-patch.ts`).

## Dashboard Build Boundary

`ui.enabled` defaults to `false`. Enabling it composes the observer and serves `ui/dist` from the MCP process. Root `setup`, `build`, and `start` build only the backend; they do not install or build UI dependencies. Use `npm run ui:install` and `npm run ui:build` for production assets, or `npm run ui:dev` for Vite with its API proxy to the configured MCP port. See the [UI wiki](../../../ui/wiki/index.md) and [HTTP Transport](../http-transport.md).

## Peekaboo Permission Integration

Shellby ships its compatible Peekaboo CLI and cursor host under `vendor/peekaboo/`; Peekaboo is not an npm dependency and is not runtime-selectable. The cursor host is resolved beside the bundled executable. `scripts/setup.ts` requests source-aware permission status through `scripts/peekaboo-permissions.mjs`; `setup:computer` delegates grants to Peekaboo rather than duplicating macOS permission logic. TCC grants attach to the responsible launching process, which is why process ancestry and PM2 launch context matter when debugging permission behavior (`vendor/peekaboo/`, `scripts/peekaboo-permissions.mjs`, `src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).

Maintainers rebuild the checked-in Universal 2 binaries from the local Peekaboo fork with `npm run vendor:peekaboo -- /absolute/path/to/Peekaboo`. The build script records source commit, hashes, toolchain, and target architectures in `vendor/peekaboo/provenance.json` (`scripts/vendor/build-peekaboo.sh`).

## Package Scripts

- Runtime check: `preflight` validates the supported host, Node 22.18.0+, local dependencies, configured shell, `tunnel-client`, the selected tunnel profile, and tunnel runtime authentication without changing runtime state. `setup -- --config-only` creates `.openchatx/config.toml` when absent; full `setup` initializes `state_dir`, including `AGENTS.md` and the starter skill, before building the backend (`scripts/preflight.ts`, `scripts/setup.ts`, `scripts/state-setup.ts`).
- Production runtime: `start` builds and starts/reloads `openchatx-tunnel` and `openchatx-mcp`; `restart` also clears the current audit log, keeping the existing PM2 daemon. `restart -- --hard` builds, kills the dedicated PM2 daemon and its apps, then clears the audit and starts fresh services. Both modes auto-launch the configured ChatGPT browser when clone or subagent tools are enabled. `status`, `logs`, and `stop` expose the small PM2 management surface. Startup removes any obsolete PM2 `shellby-cursor-host` app because cursor-host ownership now lives inside MCP. PM2 gives MCP 10 seconds to complete signal-driven cleanup before forcing termination (`package.json`, `scripts/start.ts`, `ecosystem.config.cjs`, `src/tools/computer/cursor-host.ts`).
- Development: `dev`, `build`, and `inspect` keep direct local development separate from the managed production runtime.
- Tunnel: `npm run tunnel` starts/reloads the managed `openchatx-tunnel` PM2 process. It runs `tunnel-client run --profile <profile>` and pins the local health/admin listener to `127.0.0.1:<tunnel.health_port>` (`ecosystem.config.cjs`, `.openchatx/config.toml`).
- URL/status presentation: `print-url` prints the loopback MCP target, configured tunnel profile, tunnel-client operator UI, and OpenChatX UI. `start` and `restart` call it after the managed runtime is healthy (`package.json`, `scripts/print-url.ts`, `scripts/start.ts`).
- Authentication: `auth:reset` performs the local warning/confirmation flow and clears the bound subject. It does not modify the Secure MCP Tunnel profile or runtime API key (`package.json`, `src/auth/reset.ts`).
- Subagent state: `reset-agents` deletes `<state_dir>/subagents.sqlite` plus SQLite sidecars, intentionally forgetting persisted `agent_id` conversation mappings. It does not affect ChatGPT conversations themselves (`package.json`, `scripts/chatgpt/reset-delegation-state.ts`, `src/tools/delegation/store.ts`).

Remote trust and subject binding are canonical in [HTTP Transport](../http-transport.md).

Production HTTP, MCP health checks, the tunnel-client MCP target, and the Vite API proxy share the configured MCP port. `src/server/http-server.ts` reads that process-wide value directly from `MCP_CONFIG` (`src/config.ts`, `src/server/http-server.ts`, `scripts/start.ts`, `package.json`, `ecosystem.config.cjs`).

## Failure and Recovery Boundaries

- Routine `npm run restart` works through `shell_run`: PM2 owns each app's stop/start operation inside its surviving daemon. Tunnel-client reload finishes before MCP reload is requested, since MCP shutdown can kill the requesting CLI. The initiating call can disconnect and its shell record disappears; after recovery, use a fresh tool call rather than polling the old record. Final CLI health/URL output is only available when the caller survives. No tool-specific restart behavior or detached worker is involved (`scripts/start.ts`, `test/start.test.ts`).
- Only `npm run restart -- --hard` recreates PM2. It refuses before build or mutation when inherited PM2 metadata identifies the caller as a `shellby-mcp` descendant. Killing the daemon from its own app tree can terminate the supervising command before it starts replacement services. Run hard resets from a healthy external Terminal.app session. If an earlier reset left both apps stopped, restore with external `npm start`; preserve the configured tunnel-client profile. Build must succeed before either restart mode mutates services or clears the audit; hard shutdown must succeed before audit deletion or startup. The authenticated browser profile is reused (`scripts/start.ts`, `scripts/chatgpt/browser.mjs`, `ecosystem.config.cjs`, `test/start.test.ts`).
- `This Shellby instance did not become healthy` is emitted only after PM2 returns and the bounded `/healthz` loop fails. It identifies a failed health observation, not the underlying startup cause (`scripts/start.ts`, `package.json`).
- `scripts/pm2.ts` is the shared CLI boundary for startup, restart, stop, status, logs, and `npm run pm2 -- <args>`. It sets `PM2_HOME` to `<state_dir>/pm2` even when the caller exports another PM2 home, uses the local package, and resolves ecosystem paths from the repo root. Shellby's daemon, sockets, logs, and process list are isolated from the default `~/.pm2` daemon, and separate installations can use different configured state roots. Concurrent copies also require distinct MCP ports, tunnel health ports/profiles, and any other local service ports they enable (`scripts/pm2.ts`, `scripts/start.ts`, `package.json`, `test/start.test.ts`).
- Existing installations migrating from the legacy tunnel runtime should remove obsolete legacy PM2 entries before starting the dedicated runtime, then run `npm run restart` from Terminal.app. No automatic migration touches unrelated PM2 apps. Authentication state stays in place; see README Operations.
- Use `restart -- --hard` from a healthy Terminal.app session to recover stale macOS service context. That failure can leave MCP reachable while Chromium aborts in `_RegisterApplication` and shell DNS fails. On 2026-09-08, both failures were isolated to PM2 descendants; recreating PM2 from a healthy session restored fetching. Ordinary restart preserves the daemon's context. The dedicated home limits daemon resets to Shellby; Terminal-independent lifecycle still requires a macOS LaunchAgent, which startup does not currently install.

## Related

- [Project Overview](../project-overview.md)
- [Architecture Map](../architecture-map.md)
- [HTTP Transport](../http-transport.md)
- [State and Skills](../state-and-skills.md)
- [Computer Use](../computer-use.md)
- [Build and Test](./build-and-test.md)
- [Open Questions and Risks](../project/open-questions-and-risks.md)
- [Audit Logging](./audit-logging.md)
