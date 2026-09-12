---
summary: "Uncommitted experiments and deferred architectural work that may be revisited when a concrete need justifies it."
---

# Roadmap

## What This Is

This page records uncommitted experiments and deferred architectural work; none of these items is approved or implemented merely because it appears here.

## Future experiments

- [x] Add a repo-local, gitignored `.shellby/` configuration area for user customization. `.shellby/config.toml` is the complete active public Shellby configuration surface and `.shellby/prompts/` remains the optional `start_here` prompt override surface. `npm run setup` scaffolds TOML only when absent; missing or invalid values resolve through shared defaults at load time; runtime and startup scripts consume one validated `MCP_CONFIG`; Shellby-owned workspace, shell, ChatGPT routing, and static tool-group settings come only from TOML, while validation and non-configurable limits remain code-owned in `src/config.ts`.

- [ ] Broaden host portability beyond the current macOS release without weakening the local-agent model or adding platform abstractions before they are needed.
- [ ] Add deterministic subagent lineage to `AgentIdentity` if ChatGPT exposes a proven shared identifier between a browser-backed subagent conversation and its incoming MCP `X-OpenAI-Session`. The target would let an MCP caller know whether it is a root agent, subagent, or clone and retain its parent `AgentIdentity` / browser `agent_id`. Do not restore time-window, tool-name, argument-matching, or other heuristic correlation; only implement this when the browser and MCP sides expose a deterministic join.
- [ ] Consider adding `CTRL_C` support to `shell_run` so an agent can interrupt a stuck foreground command without resetting the persistent shell and losing cwd/environment state, or adding a tool that lets the agent interrupt a foreground command.
- [ ] Redesign `shell_run` to feel closer to ChatGPT's native `container.exec`: make the common one-shot call minimal and self-contained (`command`/argv, cwd, env, timeout), make `shell_id` optional and meaningful only when persistent cwd/environment state is wanted, and simplify continuation/polling bookkeeping without weakening retry safety. Consider keeping `request_id` model-generated and descriptive rather than replacing it with an opaque server ID: naming the operation may act as a lightweight semantic anchor that helps the model stay oriented to the purpose of a command across execution and `shell_poll`. Preserve explicit persistent shells and parallel-command support as advanced capabilities rather than making every call pay their schema/state cost.
- [ ] Explore an optional headed `fetch_url` backend that reuses Shellby's existing managed Chrome/CDP profile when real-browser behavior or authenticated browsing materially improves access to sites that challenge the current headless CloakBrowser path. Keep the experiment small before introducing configuration or shared-browser lifecycle complexity.
- [ ] Evaluate an esbuild-based production artifact that keeps `tsc --noEmit` for type checking, bundles and minifies Shellby's internal code, and leaves npm dependencies external. First make repository/resource paths bundle-safe instead of deriving them from individual modules' `import.meta.url`, then benchmark startup time and artifact size against the current plain-`tsc` build; keep the simpler build if the gains are not meaningful.
- [x] Experiment with MCP resources as a deeper Shellby instruction surface. Expose a small set of Markdown guides through `resources/list` / `resources/read` or `prompts/list` / `prompts/read` for topics such as ... The experiment was complete, and chatGPT does not support `modelcontextprotocol/resources` yet.
- [x] Revisit the `io.modelcontextprotocol/tasks` extension when a supported client makes it useful. Production `/mcp` now serves MCP `2026-07-28` through the v2 `createMcpHandler` entry while retaining the SDK's stateless 2025 compatibility leg. The task probe was complete, and chatGPT does not support `modelcontextprotocol/tasks` yet.

## Related

- [Project Overview](../project-overview.md)
- [Open Questions and Risks](./open-questions-and-risks.md)
- [Possible Evals](./possible-evals.md)
- [Browser ChatGPT Subagents](../subagents/browser-chatgpt-subagents.md)
