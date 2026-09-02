---
summary: "Uncommitted experiments and deferred architectural work that may be revisited when a concrete need justifies it."
paths:
  - src/server/http-server.ts
---

# Roadmap

## What This Is

This page records uncommitted experiments and deferred architectural work; none of these items is approved or implemented merely because it appears here.

## Future experiments

- [x] Add a repo-local, gitignored `.shellby/` configuration area for user customization. `.shellby/config.toml` is the complete active public Shellby configuration surface and `.shellby/prompts/` remains the optional `start_here` prompt override surface. `npm run setup` creates and migrates the active TOML; runtime and startup scripts consume one validated `MCP_CONFIG`; Shellby-owned workspace, shell, ChatGPT routing, and static tool-group settings come only from TOML, while validation and non-configurable limits remain code-owned in `src/config.ts`.

- [ ] Broaden host portability beyond the current macOS release without weakening the local-agent model or adding platform abstractions before they are needed.
- [ ] Consider adding `CTRL_C` support to `shell_run` so an agent can interrupt a stuck foreground command without resetting the persistent shell and losing cwd/environment state.
- [ ] Redesign `shell_run` to feel closer to ChatGPT's native `container.exec`: make the common one-shot call minimal and self-contained (`command`/argv, cwd, env, timeout), remove agent-managed bookkeeping such as a required `request_id` from simple executions, make `shell_id` optional and meaningful only when persistent cwd/environment state is wanted, and return a server-generated execution handle when a command outlives the initial response so `shell_poll` can continue that process independently of shell persistence. Preserve explicit persistent shells and parallel-command support as advanced capabilities rather than making every call pay their schema/state cost.
- [x] Experiment with MCP resources as a deeper Shellby instruction surface. Expose a small set of Markdown guides through `resources/list` / `resources/read` or `prompts/list` / `prompts/read` for topics such as ... The experiment was complete, and chatGPT does not support `modelcontextprotocol/resources` yet.
- [x] Revisit the `io.modelcontextprotocol/tasks` extension when a supported client makes it useful. Production `/mcp` now serves MCP `2026-07-28` through the v2 `createMcpHandler` entry while retaining the SDK's stateless 2025 compatibility leg. The task probe was complete, and chatGPT does not support `modelcontextprotocol/tasks` yet.

## Related

- [Project Overview](../project-overview.md)
- [Open Questions and Risks](./open-questions-and-risks.md)
- [iOS Shell](../ios-shell.md)
- [Possible Evals](./possible-evals.md)
- [Browser ChatGPT Subagents](../subagents/browser-chatgpt-subagents.md)
