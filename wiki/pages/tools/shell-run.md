---
summary: "Caller-facing shell_run and shell_poll contract for persistent state, batches, polling, output retention, and lifecycle behavior."
paths:
  - src/tools/shell/shell-tools.ts
  - src/tools/shell/shell-contracts.ts
  - src/tools/shell/session.ts
---

# `shell_run` / `shell_poll`

## What This Is

Persistent zsh execution. `shell_run` starts work. `shell_poll` continues running work or retained output.

## `shell_run`

Inputs:

- `shell_id`: persistent shell name. Reuse to keep cwd + exported env. Default: `default`.
- `request_id`: unique operation name inside that shell. Same ID + same command = retry/reuse. Same ID + changed command = conflict.
- `cwd`: optional cwd change. Omit to keep cwd.
- `command`: exact zsh for one command. Mutually exclusive with `commands`.
- `commands`: independent commands to run in parallel. Each item has `command` and optional `cwd`.
- `wait_ms`: how long this call waits. Default 3000 ms, max 10 s. Returning does not stop the command.
- `max_output_tokens`: usually omit. Default 1024, max 16384. Controls one response chunk, not total retained output.

Normal commands run in the persistent shell. `cd`, exported env, functions, aliases, and other live shell state persist while that shell stays live.

One foreground operation may use a `shell_id` at a time. Use another shell ID for separate concurrent stateful work.

Normal commands have no hard runtime limit.

## Batch

Use one call for independent commands:

```json
{
  "commands": [{ "command": "npm test" }, { "command": "npm run check", "cwd": "./api" }, { "command": "pwd", "cwd": "/tmp" }]
}
```

Rules:

- Batch commands run concurrently.
- A command without `cwd` inherits batch cwd.
- Relative directory override resolves from batch cwd.
- Absolute directory override is allowed.
- Batch inherits cwd + exported env from the persistent shell.
- Child state changes do not affect the persistent shell or siblings.
- Up to 4 batch children run concurrently per shell. Extra children queue within that shell.
- Each batch child has a 30-minute runtime limit.
- One child failing does not stop siblings.
- Batch `exit_code=0` only when every child succeeds; otherwise `1`.

Batch result adds compact per-command state:

```text
commands:
- run=1 command="npm test" status=completed exit_code=0
- run=2 command="npm run check" path=./api status=completed exit_code=1
```

- `run` matches the `run=N` grouped-output header.
- `command` = first non-empty command line, normalized, max 20 characters including `…`.
- `path` appears only for a cwd override.
- Status: `queued`, `running`, `completed`, `timed_out`, `failed`, or `reset`.

Non-batch result has no `commands` field.

## Output

Normal result:

```text
status=completed cwd=/repo exit_code=0

output:
...
```

Batch output is grouped and labeled:

```text
---- run=2 path="./api" exit=1 ----

...
```

`stdout` + `stderr` share the output stream.

When zsh output contains a `command not found: apply_patch` line, normal, batch, and polled output replace that line with direct guidance to the native `apply_patch` MCP tool. Other output and the original exit status remain unchanged (`src/tools/shell/shell-tools.ts`, `test/integrations/shell.ts`).

- `output_truncated=true`: this response chunk hit its token limit. More retained output exists.
- `next_cursor`: continue from here with `shell_poll`.
- `dropped_output_bytes`: output was permanently discarded. Cannot recover it.
- Expired retained output is reported by `shell_poll` as an MCP error with `cursor_expired`; it is not a normal structured response field. Rerun if full output is required.

## `shell_poll`

Poll when `shell_run` returns `status=running`, or when more retained output is needed.

Pass:

- same `shell_id`
- same `request_id`
- previous `next_cursor` as `cursor`

Repeat with each returned `next_cursor`. `wait_ms` controls how long the poll waits; it does not stop the command. Batch polls return the same per-command `commands` summary.

Poll `wait_ms`: default 2000 ms, max 270 s (4.5 minutes).

## Shell Lifetime

- Up to 8 live shells including protected `default`.
- Named shells normally hibernate after 5 minutes idle or under live-shell pressure.
- Hibernation keeps cwd + exported env for up to 24 hours since last use.
- Hibernation loses functions, aliases, transcripts/request records, and live/background processes.
- Cached state is process-local. MCP restart loses it.
- `shell_poll` cannot continue a request after its live shell/record is gone.
- `shell_close` destroys a named shell + cached state.
- `shell_reset` destroys current state and starts clean. Use for stuck/broken shells.

## Use

- Sequential stateful work: reuse one `shell_id`.
- Independent commands: prefer one batch.
- Separate concurrent stateful workflows: use separate shell IDs.
- Large/running output: continue with `shell_poll`, not a rerun.

## Related

- [Persistent Shell Runtime](../persistent-shell-runtime.md)
- [MCP Tool Surface](../mcp-tool-surface.md)
