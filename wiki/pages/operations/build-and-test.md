---
summary: "Build boundaries, focused validation routes, CI coverage, and live-integration gaps."
paths:
  - package.json
  - tsconfig.json
  - tsconfig.build.json
  - test/
  - .github/workflows/
  - scripts/tool-schemas.ts
---

# Build and Test

## Build Boundaries

Backend uses Node 22.13.0+ and TypeScript ESM, with `src/public-config.cts` emitted as CommonJS so PM2 and the runtime share config interpretation. `tsconfig.json` typechecks source and tests; `tsconfig.build.json` emits only `src/` into `dist/`. `npm run build` removes the previous backend output before compiling. Root Prettier and ESLint configuration govern source style; exact dependency versions belong in `package.json` and the lockfile.

The React dashboard has its own package, TypeScript/Vite config, dependencies, and `ui/dist` output. Root backend build/setup/start do not build it. Use `npm run ui:install`, `npm run ui:build`, or `npm run ui:dev`; see the [UI wiki](../../../ui/wiki/index.md).

Fresh checkouts need `npm ci` and `npm run setup -- --config-only` before tests importing `MCP_CONFIG`. Config is required at module load. Tests should use temporary repositories for config loading and scaffolding and restore any process-config mutations they make.

## Validation Routes

Run the cheapest focused check that addresses the changed behavior. Broaden when shared boundaries or unresolved failures warrant it.

| Area | Useful checks |
| --- | --- |
| Config and setup | `test/config.test.ts`, `test/setup-workspace.test.ts`, `test/start.test.ts`, `test/instance-isolation.test.ts`, `test/preflight.test.ts` |
| Shell lifecycle, batches, rewriting | `test/shell-session.test.ts`, `test/shell-session-manager.test.ts`, `test/shell-parallel.test.ts`, `test/rtk.test.ts` |
| MCP contract and transport | `test/mcp-integration.test.ts` loads cases from `test/integrations/`; registration/projection also have focused tests. |
| Audit and dashboard observation | `test/mcp-audit-log.test.ts`, `test/agent-observer.test.ts`, `test/agent-context.test.ts` |
| Delegation | `test/chatgpt-subagent-browser.test.ts`, `test/chatgpt-subagent-limit.test.ts`, `test/subagent-store.test.ts` |
| Resource adapters | `test/web-fetch.test.ts`, `test/peekaboo.test.ts`, image tests, and vendor binary smoke tests |

`npm test` runs `test/*.test.ts`. `npm run typecheck` checks source and tests without emitting; `npm run lint` checks `src/` and `test/`. `npm run schemas` starts an isolated HTTP server on an ephemeral port, connects a real MCP client, and prints the configured `tools/list` schemas; optional tool-name arguments filter output. It does not restart production.

Integration tests cover modern MCP negotiation and legacy fallback, shared state across clients, startup gating and five-second instruction deduplication, static tool-group toggles, compact/structured results, owner binding on the first tool call, host rejection, and continued client use after an isolated server restart. Source `test/integrations/` owns exact coverage.

Tests use temporary directories and real local child shells. `test/helpers/temp.ts` owns disposable-directory cleanup. Process-group and vendored binary checks require the supported macOS environment. Some adapter tests inject fake executables; real vendored `apply_patch` coverage also exercises partial application and move/edit semantics.

Instance isolation tests run two disposable MCP listeners with separate auth stores, validate ngrok v2/v3 API overlays without copying credentials, exercise URL discovery against a fake ngrok API, and reject an occupied CDP endpoint belonging to another profile. Startup fixtures also reject a healthy response from a different repository/state identity. These tests do not start a public tunnel or restart the production daemon.

Local-only lifecycle coverage checks fresh startup, removal of an existing managed tunnel, cleanup failures, and hard restart. A disposable setup fixture uses the real config loader and preflight with no ngrok on `PATH`, proving disabled mode skips that prerequisite while enabled mode still requires it. URL tests ensure disabled mode never queries ngrok.

## Live Browser Validation

`npm run test:live:subagent` is a separate two-turn canary against authenticated ChatGPT. It verifies a real nonempty response and remembered context when the same agent ID is reused. It is excluded from `npm test` and refuses CI. Run only with dedicated authenticated Chrome already available and no competing subagent generation. It creates a real conversation and writes ignored diagnostic artifacts; it is not a routine docs/config check.

For private transport investigation, [ChatGPT CDP Transport](../subagents/chatgpt-cdp-transport.md) owns probe and summarizer usage. These traces can contain private conversation bodies. Neither deterministic tests nor historical observations establish current compatibility with ChatGPT's private upstream protocol.

## CI and Gaps

`.github/workflows/ci.yml` validates arm64 and x64 macOS runners: clean install, config-only setup, lint, typecheck, tests, backend build. CI does not install/build the UI or run the live browser canary.

Deterministic tests cover startup command ordering with fixtures, not a real PM2/ngrok lifecycle. Production composition, health failure recovery, signal shutdown, real browser authentication, TCC permission behavior, and cursor-host relaunch still need targeted operational validation. Unit store persistence plus the two-turn canary do not establish full browser-service restoration across a production restart. Do not claim broad runtime coverage from a successful compile or docs pass.

## Related

- [Configuration and Startup](./configuration-and-startup.md)
- [MCP Tool Surface](../mcp-tool-surface.md)
- [Open Questions and Risks](../project/open-questions-and-risks.md)
