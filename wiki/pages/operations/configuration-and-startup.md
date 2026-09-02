---
summary: "Configuration ownership and startup composition across workspace bootstrap, managed runtime, shutdown, and recovery boundaries."
paths:
  - src/config.ts
  - src/index.ts
  - scripts/
  - skills/create-skill/SKILL.md
  - ecosystem.config.cjs
---

# Configuration and Startup

## What This Is

This page maps configuration ownership, workspace bootstrap, managed runtime composition, process lifecycle, and failure boundaries to their implementation sources.

## Static MCP Configuration

`src/config.ts` requires and validates the repo-local `.shellby/config.toml`, then directly exports the process-wide `MCP_CONFIG` object. Every public configurable value comes from TOML; missing fields, unknown keys, or invalid values fail startup. `npm run setup -- --config-only` creates a complete active config for new installations and fills newly introduced fields on later runs while preserving existing values; full `npm run setup` performs the same migration before loading runtime config. The local file remains gitignored. Model-facing text response limits use `o200k_base` tokens; internal retention, cache, record, wait, and shutdown limits stay literal code-owned values. `buildMcpInstructions(workspace)` owns the global model-facing instructions and resolves `<workspace>/AGENTS.md` (`src/config.ts`, `scripts/setup.mjs`, `scripts/workspace-setup.mjs`).

Public TOML fields are intentionally small: root `workspace`; `shell.path`; `chatgpt.cdp_endpoint` and `chatgpt.project_url`; `mcp.tool_output` (`compact` or `structured`); and the `review`, `shell`, `apply_patch`, `clones`, `subagents`, `web`, `skills`, `image`, and `computer` booleans under `[tools]`. The setup-generated config enables every tool group and defaults MCP tool output to `compact`. `compact` removes ordinary public output schemas and projects results through Shellby's compact formatter; `structured` preserves the tools' native structured results and output schemas. Computer Use and `image_view` keep native MCP content in either mode. `start_here` is always enabled. Tool and MCP output settings are startup-static and require a Shellby restart (`src/config.ts`, `src/server/mcp-server.ts`, `src/server/tool-registration-boundary.ts`).

## Configuration Ownership

Shellby does not load a repository `.env` file and does not expose environment-variable overrides for its binaries, browser profile, ngrok domain, or experimental iOS bridge. Shellby user configuration belongs in `.shellby/config.toml`. ngrok authentication belongs to ngrok's native user configuration and is set with `ngrok config add-authtoken`; the executable is resolved from `PATH` and ngrok assigns the public URL. Chrome is discovered in the normal macOS application locations and uses Shellby's dedicated `~/.shellby/chatgpt-chrome` user-data directory. Computer Use always uses the package-local Peekaboo build. Shell caller-visible lifetime consequences are in [`shell_run` / `shell_poll`](../tools/shell-run.md); manager mechanics are in [Persistent Shell Runtime](../persistent-shell-runtime.md).

Production HTTP always binds to `127.0.0.1:3333`; host and port are not user-configurable. The configured `workspace` expands `~`, resolves relative values from the repository root, and becomes the shell/workspace/instruction root. Its `AGENTS.md` is the coding-instructions path advertised to MCP clients. Shell limits and lifetimes remain fixed in `MCP_CONFIG`. Audit retention and token-accounting behavior are documented in [Audit Logging](./audit-logging.md).

## Startup and Shutdown

Public startup is driven by `scripts/start.mjs`. The startup scripts import the same `MCP_CONFIG` used by runtime, so workspace and ChatGPT routing have one interpretation. Startup runs the Mac/ngrok preflight, requires the configured workspace to already exist, builds, starts or reloads the MCP and ngrok through the repository-local PM2 dependency, launches the dedicated ChatGPT Chrome profile only when clone or subagent tools are enabled, waits for `/healthz`, and prints the public `/mcp` URL. `ecosystem.config.cjs` resolves ngrok from the caller's `PATH`; it does not load repository environment files. For first-time setup, `scripts/setup.mjs` prepares the workspace and runs optional Computer Use or browser setup only for enabled tool groups. Existing workspace instructions and customized starter skills are never overwritten (`package.json`, `src/config.ts`, `scripts/preflight.mjs`, `scripts/setup.mjs`, `scripts/workspace-setup.mjs`, `scripts/start.mjs`, `skills/create-skill/SKILL.md`, `ecosystem.config.cjs`, `test/setup-workspace.test.ts`).

Inside the MCP process, `src/index.ts` is the production composition root. It constructs, starts, and disposes the shell manager, Peekaboo client, cursor host, and browser-backed agent service required by enabled tool groups; it constructs the webpage opener when web tools are enabled. `src/server/http-server.ts` receives those live services and owns only HTTP/MCP transport plus request state. Scalar process configuration is consumed directly from `MCP_CONFIG` rather than forwarded through server option bags. `src/server/mcp-server.ts` conditionally registers each enabled tool group. `apply_patch` resolves its checked-in vendored binary directly in its tool module. Authentication state and best-effort subagent conversation mappings remain under `~/.shellby/` (`src/index.ts`, `src/server/http-server.ts`, `src/server/mcp-server.ts`, `src/tools/apply-patch/apply-patch.ts`).

## Peekaboo Permission Integration

Shellby ships its compatible Peekaboo CLI and cursor host under `vendor/peekaboo/`; Peekaboo is not an npm dependency and is not runtime-selectable. The cursor host is resolved beside the bundled executable. `scripts/setup.mjs` requests source-aware permission status through `scripts/peekaboo-permissions.mjs`; `setup:computer` delegates grants to Peekaboo rather than duplicating macOS permission logic. TCC grants attach to the responsible launching process, which is why process ancestry and PM2 launch context matter when debugging permission behavior (`vendor/peekaboo/`, `scripts/peekaboo-permissions.mjs`, `src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).

Maintainers rebuild the checked-in Universal 2 binaries from the local Peekaboo fork with `npm run vendor:peekaboo -- /absolute/path/to/Peekaboo`. The build script records source commit, hashes, toolchain, and target architectures in `vendor/peekaboo/provenance.json` (`scripts/build-peekaboo.sh`).

## Package Scripts

- Runtime check: `preflight` accepts macOS arm64 and x64, then validates Node 22.13.0+, local dependencies, ngrok installation, and ngrok authentication without changing runtime state. `setup -- --config-only` only creates or migrates `.shellby/config.toml`; full `setup` wraps the runtime checks and workspace/build flow, then checks Peekaboo or Chrome only when their corresponding tool groups are enabled. `setup:computer` and `setup:chatgpt` remain explicit commands for those optional integrations (`scripts/preflight.mjs`, `scripts/setup.mjs`, `scripts/setup-ui.mjs`, `scripts/peekaboo-permissions.mjs`, `scripts/chatgpt-browser.mjs`).
- Production runtime: `start` builds and starts/reloads MCP + ngrok and auto-launches the configured ChatGPT browser only when clone or subagent tools are enabled; `restart` does the same after clearing the current audit log; `status`, `logs`, and `stop` expose the small PM2 management surface. Startup deletes any obsolete PM2 `shellby-cursor-host` app because cursor-host ownership now lives inside the MCP process. PM2 gives the MCP process 10 seconds to complete signal-driven cleanup before forcing termination (`package.json`, `scripts/start.mjs`, `ecosystem.config.cjs`, `src/tools/computer/cursor-host.ts`).
- Development: `dev`, `build`, and `inspect` keep direct local development separate from the managed production runtime.
- Tunnel: `tunnel` remains a low-level helper that exposes port 3333 through the checked-in ngrok policy with the ngrok agent's local HTTP inspector disabled. ngrok assigns the public URL (`package.json`, `ecosystem.config.cjs`).
- URL discovery: `print-url` reads ngrok's local tunnel API and prints the active `https://<domain>/mcp` URL. `start` and `restart` call it after the managed runtime is healthy (`package.json`, `scripts/print-url.mjs`, `scripts/start.mjs`).
- Authentication: `auth:reset` performs the local warning/confirmation flow and clears the bound subject. Reset does not generate or rotate an ngrok URL (`package.json`, `src/auth/reset.ts`).
- Subagent state: `reset-agents` deletes `~/.shellby/subagents.sqlite` plus SQLite sidecars, intentionally forgetting persisted `agent_id` conversation mappings. It does not affect ChatGPT conversations themselves (`package.json`, `scripts/reset-agents.mjs`, `src/tools/subagent/subagent-store.ts`).

Remote trust and subject binding are canonical in [HTTP Transport](../http-transport.md).

Production HTTP, health checks, the PM2 ngrok app, and the trusted Host rewrite deliberately share fixed local port 3333. `src/server/http-server.ts` reads that process-wide value directly from `MCP_CONFIG` (`src/config.ts`, `src/server/http-server.ts`, `scripts/start.mjs`, `package.json`, `ecosystem.config.cjs`, `ngrok-traffic-policy.yml`).

## Failure and Recovery Boundaries

- `restart` removes the current audit log, rebuilds, and asks PM2 to `startOrReload` only the MCP and ngrok definitions in `ecosystem.config.cjs`; it does not recreate the PM2 daemon or replace the authenticated browser profile (`package.json`, `scripts/start.mjs`, `scripts/chatgpt-browser.mjs`, `ecosystem.config.cjs`).
- `MCP server did not become healthy` is emitted only after PM2 returns and the bounded `/healthz` loop fails. It identifies a failed health observation, not the underlying startup cause (`scripts/start.mjs`, `package.json`).
- The PM2 daemon is user-global rather than repository-scoped. Recreating it affects every application attached to that daemon, which matters when debugging repository moves, permission-context changes, PM2 upgrades, or inconsistent daemon state (`scripts/start.mjs`, `ecosystem.config.cjs`).

## Related

- [Project Overview](../project-overview.md)
- [Architecture Map](../architecture-map.md)
- [HTTP Transport](../http-transport.md)
- [Workspace Tooling](../workspace-tooling.md)
- [Computer Use](../computer-use.md)
- [Build and Test](./build-and-test.md)
- [Open Questions and Risks](../project/open-questions-and-risks.md)
- [Audit Logging](./audit-logging.md)
