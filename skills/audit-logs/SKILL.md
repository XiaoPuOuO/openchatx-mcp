---
name: audit-logs
description: Understand and analyze Shellby's agent-commands.yaml audit log format without loading the full log into context.
---

# Agent Command Log

Use this skill to analyze `agent-commands.yaml`.

Do not load whole log into context. Parse it with Python, Node, Ruby, shell tools, whatever fits the question.

Source of truth for format:

`src/server/audit-log.ts`

## Header

```text
--- # [!|~] TOOL - DURATIONms - N in [/ N out] [- structured] [- max_output_tokens=N] [- truncated] [- HTTP ...] - Mon D h:mm AM/PM
```

- `!` = tool/HTTP/connection failure
- `~` = call took at least 5 seconds
- `in` = tokens from full serialized arguments before log truncation
- `out` = model-facing output tokens when captured
- `truncated` = bounded response capture overflowed; omitted otherwise
- final time = local call start time

Tool calls may include `session: "agent-N"`. The audit logger assigns each distinct `X-OpenAI-Session` a stable first-seen alias such as `agent-1`, `agent-2`, and so on for the logger lifetime. Raw session IDs are not written to the log.

## Tool Bodies

- `shell_run`: shell/request ID, optional cwd, and either one command or a parallel commands array
- `shell_poll`: shell/request ID, cursor
- `apply_patch`: cwd + patch size; patch body retained only on failure
- other tools: serialized `args`

## Limits

- shell command: 2,000 chars
- generic args: 600 chars
- failed patch: 32,000 chars
- failure message: 1,000 chars

## Caveats

- Missing `out` does not mean zero output.
- Shell nonzero exit produces `!` when the bounded result exposes the exit code.
- Successful tool output bodies are not stored.
- Entries are written when calls complete, so file order is not guaranteed invocation order.
- One file may contain multiple caller sessions; use `session` to group activity.
