Follow coding principles in `complexity_coding_prompt_final.md` to refactor the codebase.

`then_run` should now be working as expected so chain mcp commands together when helpful.

**ALL AGENTS/SUBAGENTS CAN EDIT THIS FILE**

## Refactor invariants

- Preserve public MCP tool names, schemas, outputs, and runtime semantics unless a change is explicitly justified.
- Never restart Shellby MCP or PM2 without Austin's explicit approval.
- Prefer deep ownership boundaries over splitting by file length. Keep cohesive state machines large when that reduces joint understanding.
- Verify changes with focused tests, typecheck, Biome, and final full-suite checks.

## Completed structural work

- MCP schema presentation separated from runtime dispatch; MCP factories snapshot immutable runtime profiles.
- HTTP owns transport/auth/audit/dashboard exposure; capability composition stays in MCP factory.
- Shell parallel lifecycle, web acquisition, patch reporting, skill catalog, process termination, Computer Use targets, and delegated-agent lifecycle each have dedicated owners.
- Deterministic integration tests no longer instantiate the real persisted ChatGPT delegation service implicitly.
- `then_run` connector schema refreshed and verified working.
- MCP mechanics now live under `src/mcp/`; main-agent observation/state lives under `src/agent/`; auth persistence is `src/auth/store.ts`.
- Subagents and clones share the `src/tools/delegation/` domain; skills live under `src/tools/skills/`.
- Agent-room/dashboard UI code is feature-oriented under `ui/src/features/`; `RoomEditor` is split by panels, selection geometry, and canvas rendering ownership.
- Integration tests are split by MCP runtime, session initialization, and HTTP transport; `tsx --test` provides recursive discovery.
- Operational setup/start/PM2/preflight/URL/workspace scripts are TypeScript where typed contracts are useful; CommonJS bootstrap, vendor build shell scripts, and browser/CDP diagnostics remain in their natural runtime formats.
- Audit execution correlation uses the MCP v2 request ID from `ctx.mcpReq.id` rather than recursive argument matching.
- Short-lived per-agent load dedupe state self-prunes after its cooldown.
- Final validation: 314 tests passed / 21 expected skips / 0 failed; backend typecheck/lint/build/schemas, UI lint/build, vendor snapshot check, stale-path scan, and `git diff --check` all pass.

## Remaining intentional boundaries

- Keep cohesive state machines such as shell process/session, web acquisition, delegation lifecycle, and agent-room engine/renderer large when further splitting would increase joint understanding.
- `src/agent/context.ts` intentionally retains process-lifetime identities because audit aliases and `start_here` gating depend on stable identity semantics.
- The dashboard observer retains process-lifetime observed-agent history; bounding that history would be a product-semantic choice, not a complexity-only cleanup.
- Routine tests skip live browser-backed web cases unless their live flag is enabled, and the room editor has build/lint rather than browser-interaction coverage.

## Coordination

- Subagents retain their conversation context; do not repeat the complexity prompt every turn. Use this file for newly shared constraints and cross-agent state.
- Before finalizing architecture, research current official MCP TypeScript SDK v2 and Express 5 guidance with native web search; prefer official sources.
- Current official MCP v2 pattern: `createMcpExpressApp` + one `toNodeHandler(createMcpHandler(factory))`; the factory creates a fresh MCP server per request and the same factory serves modern 2026-07-28 plus stateless 2025 fallback. Keep capability state outside those short-lived servers.
- Add only concise cross-agent facts or blockers here; remove stale coordination notes as work lands.
