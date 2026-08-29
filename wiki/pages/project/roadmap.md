---
summary: "Uncommitted experiments and deferred architectural work that may be revisited when a concrete need justifies it."
paths:
  - experiments/mcp-2026-tasks-probe/
---

# Roadmap

## What This Is

This page records uncommitted experiments and deferred architectural work; none of these items is approved or implemented merely because it appears here.

## Future experiments

- [ ] Broaden host portability beyond the current macOS release without weakening the local-agent model or adding platform abstractions before they are needed.
- [ ] Revisit MCP `2026-07-28` and the current `io.modelcontextprotocol/tasks` extension only if they solve a concrete problem or materially simplify Shellby MCP. A self-contained manual compatibility probe is preserved at `experiments/mcp-2026-tasks-probe/`; do not wire it into the production `/mcp` server unless this roadmap item is intentionally resumed.
- [ ] Consider adding `CTRL_C` support to `shell_run` so an agent can interrupt a stuck foreground command without resetting the persistent shell and losing cwd/environment state. The current non-interactive shell has no terminal job-control foreground process group, so a safe implementation would need to signal only the process tree created by the active command rather than the shell's whole process group; true terminal-equivalent Ctrl+C semantics would require a larger PTY/job-control redesign.
- [ ] Experiment with MCP resources as a deeper Shellby instruction surface. Expose a small set of Markdown guides through `resources/list` / `resources/read` or `prompts/list` / `prompts/read` for topics such as Computer Use, persistent shells, subagents, and troubleshooting, then observe whether ChatGPT autonomously discovers and reads the relevant resource when tool descriptions alone are insufficient. Do not move critical instructions out of existing MCP, tool, or workspace guidance until that behavior is demonstrated reliably.

## Related

- [Project Overview](../project-overview.md)
- [Open Questions and Risks](./open-questions-and-risks.md)
- [iOS Shell](../ios-shell.md)
- [Possible Evals](./possible-evals.md)
- [Browser ChatGPT Subagents](../subagents/browser-chatgpt-subagents.md)
