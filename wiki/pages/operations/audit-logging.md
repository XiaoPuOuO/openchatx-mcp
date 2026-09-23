---
summary: "Repository-local MCP audit logging, retention limits, token accounting, status markers, and sensitivity rules."
paths:
  - src/server/audit/
  - src/server/http-server.ts
  - src/tools/computer/computer-tools.ts
  - src/tokenizer.ts
  - test/server/audit-log.test.ts
---

# Audit Logging

## What This Is

Canonical behavior for the repository-local MCP tool audit log.

## Storage and Scope

Production injects one `McpAuditLogger` and appends completed `tools/call` activity plus one timestamped line for each `tools/list` request to gitignored `agent-commands.yaml`. Other non-tool MCP requests are ignored. The file is created or repaired with owner-only `0600` permissions. Audit failures are best-effort and never change MCP dispatch (`src/index.ts`, `src/server/http-server.ts`, `src/server/audit/audit-log.ts`, `test/server/audit-log.test.ts`).

Each call is one compact YAML document containing the tool name, duration, a human-readable local timestamp such as `Aug 26 11:05 PM`, bounded input context, model-facing token counts when they can be derived safely, and the current agent identity when `X-OpenAI-Session` is supplied by the client. Shellby's shared agent context maps each distinct session to `agent-1`, `agent-2`, and so on in first-seen order for the MCP process lifetime. A successful `start_here` call adds its `task_id` as that identity's task context, so later entries use labels such as `agent-1/audit-session-labels`; the `start_here` entry itself keeps the identity as it existed when that call began. Raw OpenAI session values are not written to the audit log. Ordinary tool output is not persisted (`src/agent/context.ts`, `src/server/audit/audit-log.ts`, `src/tools/start-here/start-here.ts`).

Session aliases identify only the conversation that made the MCP request. The audit log does not infer caller relationships or classify sessions as subagents (`src/server/http-server.ts`, `src/server/audit/audit-log.ts`).

## Retention Rules

- `shell_run` command text is retained as a block scalar capped at 2,000 characters.
- `shell_run` entries retain `shell_id/request_id` as one `shell` key, explicitly supplied `yield_time_ms` / `max_output_tokens`, and optional requested cwd; `shell_poll` entries retain the same shell/request identity, requested cursor, and explicitly supplied `yield_time_ms` / `max_output_tokens`. Omitted defaults stay omitted so the log distinguishes caller choices from Shellby defaults. When the handler result is available, both also retain a compact `result` summary containing useful fields such as status, exit code, actual cwd, cursor, and truncation/drop state. Failed shell calls retain their MCP failure message capped at 1,000 characters.
- Ordinary tool arguments are capped at 600 characters.
- Successful `apply_patch` calls retain cwd and patch size, not patch text.
- Failed `apply_patch` calls may retain the bounded failure message and up to 32,000 patch characters.
- Audit receives handler results directly at the registration boundary, before HTTP serialization. It does not buffer or truncate the HTTP response. Input/failure persistence limits above still apply.
- Computer Use keeps a whitelist of structured metadata such as snapshot ID, application/window identity, capture mode, and element counts. Screenshot bytes and inspection trees are excluded from persisted output.
- Transport completion records calls never claimed by a handler using request metadata and HTTP completion state. It adds no generic error message or replacement note; HTTP failures and closed connections still receive the existing failure marker. Remote authorization failures occur before audit request creation.

The logger records serialized tool arguments as model-facing `in` tokens. When a model-facing result is available, `out` counts the final projected text plus any structured result after compact/structured projection and completion-event, human-steering, and review-notice injection, excluding image payloads. Counting has no audit byte cap; ordinary output is counted without being persisted. These are MCP I/O counts, not model-inference usage (`src/server/audit/audit-log.ts`, `src/server/audit/audit-format.ts`, `src/tokenizer.ts`, `test/server/audit-log.test.ts`).

## Status Markers and Sensitivity

Calls lasting at least five seconds use `~`; tool, HTTP, and connection failures use `!`; `shell_run` results with a nonzero subprocess exit code also use `!`. A nonzero exit reported only by `shell_poll` is not independently promoted to a failure marker. Normal calls have no Better Comments marker. Headings contain only call-wide metadata; tool-specific arguments stay in the body. Abnormal HTTP completion adds `HTTP <status> <finished|closed>` so transport failures can be identified directly (`src/server/audit/audit-format.ts`, `test/server/audit-log.test.ts`).

The log can contain shell commands, prompt prefixes, URLs, Computer Use inputs, and failed patch text. Treat the entire file as sensitive local operational data even though it is gitignored and permission-restricted. See [Secret Handling](./secret-handling.md).

## Related

- [HTTP Transport](../http-transport.md)
- [Configuration and Startup](./configuration-and-startup.md)
- [Secret Handling](./secret-handling.md)
- [Open Questions and Risks](../project/open-questions-and-risks.md)
- [apply_patch](../tools/apply-patch.md)
