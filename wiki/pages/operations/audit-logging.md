---
summary: "Repository-local MCP audit logging, retention limits, token accounting, status markers, and sensitivity rules."
paths:
  - src/server/audit-log.ts
  - src/server/http-server.ts
  - src/tools/computer/computer-tools.ts
  - src/tokenizer.ts
  - test/mcp-audit-log.test.ts
---

# Audit Logging

## What This Is

Canonical behavior for the repository-local MCP tool audit log.

## Storage and Scope

Production injects one `McpAuditLogger` and appends completed `tools/call` activity plus one timestamped line for each `tools/list` request to gitignored `agent-commands.yaml`. Other non-tool MCP requests are ignored. The file is created or repaired with owner-only `0600` permissions. Audit failures are best-effort and never change MCP dispatch (`src/index.ts`, `src/server/http-server.ts`, `src/server/audit-log.ts`, `test/mcp-audit-log.test.ts`).

Each call is one compact YAML document containing the tool name, duration, a human-readable local timestamp such as `Aug 26 11:05 PM`, bounded input context, model-facing token counts when they can be derived safely, and a readable session alias when `X-OpenAI-Session` is supplied by the client. The logger maps each distinct raw session to `agent-1`, `agent-2`, and so on in first-seen order for that logger lifetime. A successful `start_here` call may add its `task_slug` to later entries for that session, for example `agent-1/audit-session-labels`; the `start_here` entry itself keeps the plain first-seen alias. Raw OpenAI session values remain internal and are not written to the audit log. Ordinary tool output is not persisted (`src/server/audit-log.ts`, `src/tools/start-here/start-here.ts`).

Session aliases identify only the conversation that made the MCP request. The audit log does not infer caller relationships or classify sessions as subagents (`src/server/http-server.ts`, `src/server/audit-log.ts`).

## Retention Rules

- `shell_run` command text is retained as a block scalar capped at 2,000 characters.
- `shell_run` entries retain `shell_id/request_id` as one `shell` key plus optional requested cwd; `shell_poll` entries retain the same shell/request identity plus the requested cursor. When the bounded response is available, both also retain a compact `result` summary containing useful fields such as status, exit code, actual cwd, cursor, and truncation/drop state. Failed shell calls retain their MCP failure message capped at 1,000 characters.
- Ordinary tool arguments are capped at 600 characters.
- Successful `apply_patch` calls retain cwd and patch size, not patch text.
- Failed `apply_patch` calls may retain the bounded failure message and up to 32,000 patch characters.
- The first 8 KiB of a response body may be captured temporarily for token accounting and compact result extraction, then is discarded. If the bounded capture overflows, `out` is omitted rather than guessed and the heading records `truncated`. Otherwise the marker is omitted.
- Computer Use follows the same bounded response capture. Its small structured metadata is serialized before screenshot content so screenshot-heavy observations can still retain a compact whitelist such as snapshot ID, application/window identity, capture mode, and element counts from the bounded prefix. Screenshot bytes, inspection text/UI trees, and other raw Computer output are never persisted.

The logger records serialized tool arguments as model-facing `in` tokens. When a complete bounded response is available, `out` counts the final projected text plus any structured result after compact/structured projection and completion-event injection, excluding image payloads. These are MCP I/O counts, not model-inference usage (`src/server/audit-log.ts`, `src/tokenizer.ts`, `test/mcp-audit-log.test.ts`).

## Status Markers and Sensitivity

Calls lasting at least five seconds use `~`; tool, HTTP, and connection failures use `!`; completed `shell_run`/`shell_poll` results with a nonzero subprocess exit code also use `!`. Normal calls have no Better Comments marker. Explicit `structured=true` and `max_output_tokens` arguments are surfaced in the heading, and abnormal HTTP completion adds `HTTP <status> <finished|closed>` so transport failures can be identified directly (`src/server/audit-log.ts`, `test/mcp-audit-log.test.ts`).

The log can contain shell commands, prompt prefixes, URLs, Computer Use inputs, and failed patch text. Treat the entire file as sensitive local operational data even though it is gitignored and permission-restricted. See [Secret Handling](./secret-handling.md).

## Related

- [HTTP Transport](../http-transport.md)
- [Configuration and Startup](./configuration-and-startup.md)
- [Secret Handling](./secret-handling.md)
- [Open Questions and Risks](../project/open-questions-and-risks.md)
- [apply_patch](../tools/apply-patch.md)
