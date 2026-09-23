---
summary: "Process-level architecture and request flow across Shellby's HTTP boundary, shared runtime services, and capability handlers."
paths:
  - src/index.ts
  - src/config.ts
  - src/public-config.cts
  - src/agent/
  - src/mcp/
  - src/server/
  - src/tools/
---

# Architecture Map

## What This Is

This page maps the process-level components and follows one request from the HTTP boundary into shared runtime state and capability handlers.

## Layers

| Layer                 | Responsibility                                                                                                                                  | Implementation                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Static MCP config     | Resolve TOML overrides with shared defaults, then define server identity, runtime limits, and global instructions                      | `src/config.ts`                          |
| Process entry         | Consume static configuration, conditionally compose enabled runtime services, handle shutdown                                                   | `src/index.ts`                           |
| HTTP boundary         | Bind localhost, apply MCP Express HTTP guards, expose health/MCP routes, and adapt the v2 per-request MCP handler to Node                       | `src/server/http-server.ts`              |
| Remote authentication | Persist the bound ChatGPT subject outside the repo                                                                                              | `src/auth/store.ts`                      |
| MCP audit log         | Record timestamped `tools/list` requests plus completed `tools/call` metadata without affecting dispatch                                        | `src/server/audit/`                      |
| Main-agent context    | Map opaque ChatGPT sessions to process-local agent identities and task context                                                                  | `src/agent/context.ts`                   |
| Agent observation     | Track current/recent tool activity and queued human steering; expose local dashboard routes                                                     | `src/agent/observer.ts`, `src/agent/dashboard-routes.ts` |
| MCP composition       | Bind process-level capability services once, snapshot the runtime profile, publish shared instructions, and register enabled tools              | `src/mcp/server-factory.ts`              |
| MCP execution boundary | Gate initialized sessions, invoke tool handlers, project results, append notices, and connect audit/observer lifecycles                         | `src/mcp/tool-registration-boundary.ts`  |
| MCP schema presentation | Own model-facing schema projection, annotation pruning, compact-output schema visibility, and native-content exceptions                         | `src/mcp/tool-schema-presentation.ts`    |
| Tool contracts        | Own tool schemas, descriptions, handlers, result shaping, and capability-specific errors                                                        | `src/tools/`                             |
| Computer Use tools    | Publish eleven focused schemas, validate targets, and normalize compact MCP results                                                             | `src/tools/computer/computer-tools.ts`   |
| Peekaboo adapter      | Invoke the CLI without a shell, serialize calls, parse bounded JSON, and retain snapshot targets                                                | `src/tools/computer/peekaboo.ts`         |
| Cursor host manager   | Own the optional background `peekaboo-cursor-host` child, restart it after unexpected exit, and stop it during MCP shutdown                     | `src/tools/computer/cursor-host.ts`      |
| Shell manager         | Lazily create/restore named shells, manage live LRU capacity, hibernate idle shells, and expire cached recoverable state                        | `src/tools/shell/session-manager.ts`     |
| Shell process         | Own the persistent child shell, marker protocol, context capture, process signaling, reset, and generation                                      | `src/tools/shell/shell-process.ts`       |
| Shell session         | Own persistent-shell arbitration, single-command records, transcripts, retries, pagination, and orchestration around the shell process           | `src/tools/shell/session.ts`             |
| Parallel shell session | Own batch request records, retries, polling, snapshots, pruning, and reset cancellation                                                         | `src/tools/shell/parallel-session.ts`    |
| Parallel shell runner | Execute `commands` batches, enforce four children per shell, run isolated shell jobs, cap output, timeout, and clean process groups             | `src/tools/shell/parallel-runner.ts`     |
| Apply Patch           | Publish the first-class patch tool and own the vendored child-process lifecycle                                                                 | `src/tools/apply-patch/apply-patch.ts`   |
| Patch reporting       | Interpret submitted patch sections and native first-failure diagnostics into `changed` / `failed` summaries                                    | `src/tools/apply-patch/patch-summary.ts` |
| Skill catalog         | Discover, validate, and load reusable workspace `SKILL.md` files dynamically                                                                    | `src/tools/skills/skill-catalog.ts`      |
| Website retention     | Own bounded retained documents, cursor pagination, TTL/LRU, and token paging                                                                    | `src/tools/web/web-open.ts`              |
| Website acquisition   | Own browser/CDP acquisition, MIME handling, HTML/PDF/image/text conversion, and acquisition cleanup                                             | `src/tools/web/web-acquisition.ts`       |
| ChatGPT delegation    | Attach to authenticated Chrome, serve both subagents and clones, enforce the configured delegated-agent cap (default three), and complete from CDP turn streams | `src/tools/delegation/chatgpt-service.ts` |
| Delegation store      | Persist best-effort `agent_id` -> conversation URL + turn count mappings outside the repository                                                 | `src/tools/delegation/store.ts`          |

The optional `AgentObserver` owns observed agent/call state and queued human instructions. `src/agent/dashboard-routes.ts` owns its localhost HTTP/SSE routes, while `src/agent/tool-call-presentation.ts` owns tool-specific dashboard summaries. The observer is composed only when `ui.enabled`; static UI builds and frontend presentation belong to the [UI wiki](../../ui/wiki/index.md). [HTTP Transport](./http-transport.md) owns the local exposure boundary.

## Request Lifecycle

Tool registration enters a shared execution pipeline through an instance-level `McpServer.registerTool` override. The factory installs it before registering any tool. [MCP Tool Registration Boundary](./mcp-tool-registration-boundary.md) shows both phases and the ordering contract.

1. `src/config.ts` loads `.shellby/config.toml` through the shared forgiving loader; `src/index.ts` prepares durable/process-level state and composes only the runtime services required by enabled tool groups (`src/config.ts`, `src/index.ts`).
2. `src/mcp/server-factory.ts` binds the process-level capability services into one `McpServerFactory`, snapshots its immutable MCP runtime profile, and owns the process-local review tracker. `src/server/http-server.ts` receives that factory plus transport concerns such as auth, audit, and the optional observer.
3. `src/server/http-server.ts` accepts an MCP request, applies the HTTP/ownership boundary, and routes it through `createMcpHandler`. The handler selects modern `2026-07-28` or stateless legacy serving and obtains a short-lived MCP server from the bound factory, passing the same HTTP-owned observer used by dashboard routes. `src/mcp/server-factory.ts` registers `start_here` plus profile-enabled tool groups; each capability module owns its public contract and domain behavior.
4. Stateful capabilities retain only their intended boundary: named shells and webpage documents are process-local; Computer Use capture targets are process-local; delegated turn state is process-local while main-session-scoped conversation URL + turn count mappings persist best-effort in `<state_dir>/subagents.sqlite`. Dedicated pages document those lifecycles.

## Related

- [Project Overview](./project-overview.md)
- [UI Dashboard Wiki](../../ui/wiki/index.md)
- [HTTP Transport](./http-transport.md)
- [MCP Tool Surface](./mcp-tool-surface.md)
- [MCP Tool Registration Boundary](./mcp-tool-registration-boundary.md)
- [Configuration and Startup](./operations/configuration-and-startup.md)
- [Computer Use](./computer-use.md)
- [Browser ChatGPT Subagents](./subagents/browser-chatgpt-subagents.md)
- [Audit Logging](./operations/audit-logging.md)
