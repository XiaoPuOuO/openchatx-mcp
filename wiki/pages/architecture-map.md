---
summary: "Process-level architecture and request flow across Shellby's HTTP boundary, shared runtime services, and capability handlers."
paths:
  - src/index.ts
  - src/server/
  - src/tools/
---

# Architecture Map

## What This Is

This page maps the process-level components and follows one request from the HTTP boundary into shared runtime state and capability handlers.

## Layers

| Layer                 | Responsibility                                                                                                                                  | Implementation                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Static MCP config     | Define server identity, shared tool metadata, runtime defaults, and global instructions                                                         | `src/config.ts`                          |
| Process entry         | Consume static configuration, prepare workspace state, compose dependencies, handle shutdown                                                    | `src/index.ts`                           |
| HTTP boundary         | Bind localhost, apply MCP Express HTTP guards, expose health/MCP routes, and adapt the v2 per-request MCP handler to Node                       | `src/server/http-server.ts`              |
| Remote authentication | Persist the bound ChatGPT subject outside the repo                                                                                              | `src/auth/auth.ts`                       |
| MCP audit log         | Record timestamped `tools/list` requests plus completed `tools/call` metadata without affecting dispatch                                       | `src/server/audit-log.ts`                |
| MCP composition       | Publish shared instructions and register capability tool modules                                                                                | `src/server/mcp-server.ts`               |
| Tool contracts        | Own tool schemas, descriptions, handlers, result shaping, and capability-specific errors                                                        | `src/tools/`                             |
| Computer Use tools    | Publish eleven focused schemas, validate targets, and normalize compact MCP results                                                             | `src/tools/computer/computer-tools.ts`   |
| Peekaboo adapter      | Invoke the CLI without a shell, serialize calls, parse bounded JSON, and retain snapshot targets                                                | `src/tools/computer/peekaboo.ts`         |
| Cursor host manager   | Own the optional background `peekaboo-cursor-host` child, restart it after unexpected exit, and stop it during MCP shutdown                    | `src/tools/computer/cursor-host.ts`      |
| Shell manager         | Lazily create/restore named shells, manage live LRU capacity, hibernate idle shells, and expire cached recoverable state                        | `src/tools/shell/session-manager.ts`     |
| Shell process         | Own the persistent child shell, marker protocol, context capture, process signaling, reset, and generation                                     | `src/tools/shell/shell-process.ts`       |
| Shell session         | Own transcripts, command/batch records, retries, pagination, and orchestration around the shell process                                         | `src/tools/shell/session.ts`             |
| Parallel shell runner | Execute `commands` batches, enforce four children per shell, run isolated shell jobs, cap output, timeout, and clean process groups                  | `src/tools/shell/parallel-runner.ts`     |
| Apply Patch           | Publish the first-class patch tool and execute the checked-in vendored binary directly                                                          | `src/tools/apply-patch/apply-patch.ts`   |
| Skill catalog         | Discover and load reusable workspace `SKILL.md` files dynamically                                                                               | `src/tools/skills.ts`                    |
| Website fetching      | Produce Markdown, cleaned HTML, or raw rendered HTML and retain bounded cursor-addressed documents                                              | `src/tools/web/web-open.ts`              |
| ChatGPT subagents     | Attach to authenticated Chrome, keep one project-aware page per agent, run up to three detached generations, and complete from CDP turn streams | `src/tools/subagent/chatgpt-subagent.ts` |
| Subagent store        | Persist best-effort `agent_id` -> conversation URL + turn count mappings outside the repository                                                | `src/tools/subagent/subagent-store.ts`   |

## Request Lifecycle

1. `src/index.ts` parses configuration, prepares durable/process-level state, and composes shared runtime services (`src/index.ts`, `src/config.ts`).
2. `src/server/http-server.ts` accepts an MCP request, applies the HTTP/ownership boundary, and routes it through `createMcpHandler`. The handler selects modern `2026-07-28` or stateless legacy serving and obtains a short-lived MCP server from the shared factory. See [HTTP Transport](./http-transport.md).
3. `src/server/mcp-server.ts` registers the model-facing tools; the selected capability module under `src/tools/` owns its schema, handler, result, and domain errors.
4. Stateful capabilities retain only their intended boundary: named shells and webpage documents are process-local; Computer Use capture targets are process-local; subagent turn state is process-local while conversation URL + turn count persist best-effort in `~/.shellby/subagents.sqlite`. Dedicated pages document those lifecycles.

## Related

- [Project Overview](./project-overview.md)
- [HTTP Transport](./http-transport.md)
- [MCP Tool Surface](./mcp-tool-surface.md)
- [Configuration and Startup](./operations/configuration-and-startup.md)
- [Computer Use](./computer-use.md)
- [Browser ChatGPT Subagents](./subagents/browser-chatgpt-subagents.md)
- [Audit Logging](./operations/audit-logging.md)
