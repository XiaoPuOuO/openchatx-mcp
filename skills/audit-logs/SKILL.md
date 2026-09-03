---
name: audit-logs
description: Understand and analyze Shellby's agent-commands.yaml audit log format without loading the full log into context.
---

# Agent Command Log

Use this skill to analyze `agent-commands.yaml`.

Do not load the whole log into context. Inspect, filter, parse, aggregate, or sample it with Python, Node, Ruby, shell tools, or another approach that fits the audit question. Choose the investigation method from the evidence you need rather than forcing every audit through one fixed workflow.

The `--- # ...` record header is stored as a YAML comment. Generic YAML parsers may discard the tool name, duration, token counts, status marker, and timestamp carried there. When that metadata matters, read the file as text or otherwise preserve and parse the header separately from the YAML body.

Prefer reducing the log outside model context before reading detailed records. Useful reductions may include filtering by session, task slug, tool, status marker, time range, shell/request identity, arguments, or any other feature relevant to the question; grouping, counting, sorting, sequence analysis, and targeted record inspection are all valid. Bring only the evidence needed for the current audit into context.

Source of truth for format:

`src/server/audit/audit-log.ts`
`src/server/audit/audit-format.ts`

## Header

```text
--- # [!|~] TOOL - DURATIONms - N in [/ N out] [- HTTP ...] - Mon D h:mm AM/PM
```

- `!` = tool/HTTP/connection failure
- `~` = call took at least 5 seconds
- `in` = tokens from full serialized arguments before log truncation
- `out` = model-facing text/structured output tokens; native image payloads are excluded
- final time = local call start time

Tool calls may include `session: "agent-N"` or, after a successful `start_here`, `session: "agent-N/task-slug"`. Shellby's shared agent context assigns each distinct `X-OpenAI-Session` a stable process-local identity such as `agent-1`, `agent-2`, and so on. A successful `start_here` adds that caller's `task_id`; later audit entries append it to the agent label, for example `agent-1/audit-session-labels`. The `start_here` entry itself keeps the plain `agent-N` label. Raw session IDs are not written to the log.

For ChatGPT sessions, `start_here` is normally the first successful Shellby tool call for that session.

## Tool Bodies

- `shell_run`: shell/request ID, explicitly supplied `wait_ms` / `max_output_tokens`, optional cwd, and either one command or a parallel commands array
- `shell_poll`: shell/request ID, cursor, and explicitly supplied `wait_ms` / `max_output_tokens`
- `apply_patch`: cwd + patch size; patch body retained only on failure
- other tools: serialized `args`

## Limits

- shell command: 2,000 chars
- generic args: 600 chars
- failed patch: 32,000 chars
- failure message: 1,000 chars

## Caveats

- Missing `out` means there was no token-countable model-facing text or structured output.
- Shell nonzero exit produces `!` when the bounded result exposes the exit code.
- Successful tool output bodies are not stored.
- Entries are written when calls complete, so file order is not guaranteed invocation order.
- One file may contain multiple caller sessions. Group a conversation by its `agent-N` prefix because entries before successful `start_here` use `agent-N` while later entries may use `agent-N/task-slug`.
