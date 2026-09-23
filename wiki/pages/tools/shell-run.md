---
summary: "Caller-facing shell_run and shell_poll contract for persistent state, batches, polling, output retention, and lifecycle behavior."
paths:
  - src/tools/shell/shell-tools.ts
  - src/tools/shell/shell-contracts.ts
  - src/tools/shell/session.ts
  - src/tools/shell/parallel-session.ts
  - src/tools/shell/rtk.ts
  - src/mcp/tool-output.ts
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
- `yield_time_ms`: wait before yielding a still-running command. Default 10 s, max 10 s. Commands that finish sooner return immediately. Returning does not stop the command.
- `max_output_tokens`: usually omit. Default 1024, max 16384. Controls one response chunk, not total retained output.

For single commands and batches, the output limit does not shorten `yield_time_ms`. Use a shorter yield when intermediate output is needed sooner. Existing retention limits still apply while waiting.

Normal commands run in the persistent shell. `cd`, exported env, functions, aliases, and other live shell state persist while that shell stays live.

When `shell.rtk = true`, Shellby may transparently rewrite supported commands through the external RTK executable resolved at startup before evaluation. Callers still send normal zsh; request identity, retries, auditing, and command previews use the original command. Unsupported or failed rewrites execute the exact original command, and `RTK_DISABLED=1 <command>` bypasses rewriting for one command.

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
- Batch run/retry/poll waits for completion or the requested yield deadline even when output fills a page. Completed batches report `status=completed` with their exit code while unread output remains; pagination does not keep work running.

Batch result puts per-command state before output, in input order:

```text
commands:
- run=1 exit_code=0 command="npm test"
- run=2 exit_code=1 command="npm run check" path=./api
```

- `run` matches the `run=N` grouped-output header.
- `command` = first non-empty command line, normalized, max 20 characters including `…`.
- `path` appears only when the command's resolved cwd differs from the batch cwd.
- Compact text omits `status=completed` when a numeric exit code conveys completion, and omits null exit codes. Other states (`queued`, `running`, `timed_out`, `failed`, or `reset`) remain visible. Structured results retain the full status and nullable exit code.
- Per-command dropped-output counts appear in this summary. The summary remains available on every output page.

Non-batch result has no `commands` field.

## Output

Normal result:

```text
status=completed cwd=/repo exit_code=0

output:
...
```

Batch output remains in completion order. Headers only identify the run; exit codes, paths, and dropped-output counts live in the summary:

```text
---- run=2 ----

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

Repeat with each returned `next_cursor` while status remains `running`, or while more retained output is needed. `shell_poll` long-polls until completion or `yield_time_ms` expiry, regardless of unread output. Batch polls return the same per-command `commands` summary. `yield_time_ms` does not stop the command.

Poll `yield_time_ms`: default 40 s, max 30 minutes. For ordinary running commands, omit it and let the default long poll return early on completion. Use a shorter yield to inspect intermediate output sooner.

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
- [Configuration and Startup](../operations/configuration-and-startup.md)
- [MCP Tool Surface](../mcp-tool-surface.md)
