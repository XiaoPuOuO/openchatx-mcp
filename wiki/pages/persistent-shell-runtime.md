---
summary: "Persistent shell manager and session internals, including lifecycle, transcripts, concurrency, polling, and recovery."
paths:
  - src/tools/shell/
  - test/shell-session.test.ts
  - test/shell-session-manager.test.ts
  - test/shell-parallel.test.ts
---

# Persistent Shell Runtime

## What This Is

Implementation notes for the stateful named-shell runtime behind `shell_run` and `shell_poll`. Caller-facing behavior and syntax live in [shell_run](./tools/shell-run.md).

## Process Model

- `shell-process.ts` owns the persistent non-interactive shell child, command/context markers, shell generation, cwd/environment capture, and reset/close signaling. `session.ts` owns persistent-shell arbitration, single-command records, output pagination, retry identity, and orchestration around that process. `parallel-session.ts` owns parallel-batch records, scheduling lifecycle, grouped output, retries/polling, and reset cancellation (`src/tools/shell/shell-process.ts`, `src/tools/shell/session.ts`, `src/tools/shell/parallel-session.ts`).
- The process layer spawns `/bin/sh -c 'exec "$1" -f 2>&1'` with the configured shell as `$1`, using fast startup instead of login startup. With zsh, user startup files are skipped; commands inherit Shellby’s process environment. Parallel children use the same `-f` policy with `-c`. Do not assume Terminal aliases or login-script PATH changes exist. POSIX children are detached into a process group so reset and close can signal the group, including background descendants. Platform-specific group signaling and reusable TERM-to-KILL escalation live in `src/child-process-termination.ts`; shell state/finalization remains owned by the shell modules.
- The initial working directory and environment come from constructor options. There is no PTY. Commands run through the persistent shell while stdout/stderr feed the process parser (`src/tools/shell/shell-process.ts`).

## Command Protocol

Commands are passed into a fixed wrapper script, optionally preceded by a validated absolute `cwd` change, evaluated in the existing shell, and followed by a randomized record-separator completion marker containing exit code plus resulting `$PWD`. When `shell.rtk` is enabled, `rtk.ts` asks the RTK executable resolved from Shellby's startup `PATH` to rewrite supported commands and temporarily places that executable's directory first on `PATH` only for the rewritten evaluation. RTK exit codes meaning passthrough/deny, rewrite failures, and unsupported commands all execute the caller's exact original command instead. Request hashing, audit input, previews, and retained command identity remain based on that original command because rewriting happens only at the process execution boundary. Parallel child commands use the same rewrite boundary (`src/tools/shell/rtk.ts`, `src/tools/shell/shell-process.ts`, `src/tools/shell/parallel-runner.ts`, `src/tools/shell/session.ts`, `test/rtk.test.ts`).

Marker-safe decoding and parsing live in `shell-process.ts`; retained transcript/capture ceilings remain in the session layer (`src/tools/shell/shell-process.ts`, `src/tools/shell/session.ts`, `test/shell-session.test.ts`).

When a complete marker is absent, the parser publishes ordinary output immediately and retains only the longest trailing substring that could begin the expected marker. This makes short readiness messages available before command completion while keeping split markers private and Unicode boundaries intact. The session still returns at completion or the caller's yield deadline.

The wrapper clears `errexit` before and after evaluation so a prior `set -e` does not poison later calls. An explicit `exit` or a command that terminates the shell still destroys state (`src/tools/shell/shell-process.ts`, `test/shell-session.test.ts`).

## Output Storage and Request Records

- `TranscriptBuffer` uses absolute JavaScript-string cursors, advances a logical retained-output head as the rolling window fills, and compacts discarded backing text in batches instead of slicing the full retained string on every append. It drops whole surrogate pairs at the rolling boundary. A cursor older than retained output is clamped and returns `cursor_expired` (`src/tools/shell/session.ts`, `test/shell-session.test.ts`).
- Response ceilings use `o200k_base` token counts. Transcript reads tokenize only a bounded local character window instead of the entire remaining transcript, so polling large retained output does not repeatedly rescan megabytes. Per-command capture remains byte-based because it protects retained memory (`src/tokenizer.ts`, `src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`). See [shell_run](./tools/shell-run.md) for caller-visible pagination/loss semantics.
- Run, retry, and poll share a wait loop ending on completion, abort/reset, or the yield deadline. Output volume and cursor expiry do not shorten the wait. Versioned updates wake the loop; transcript pagination happens only when constructing the response (`src/tools/shell/session.ts`).
- Command request IDs are scoped to a shell. Exact command retries return the retained record; changed text returns `request_conflict`. Command records are bounded by the code-owned `MCP_CONFIG.shell.recordLimit`. Reset has no request ID or retained retry record (`src/config.ts`, `src/tools/shell/session.ts`).

## Concurrency

Each named shell accepts one foreground command. Different shell IDs run independently. Direct `apply_patch` processes bypass shell locks, transcripts, and request records (`src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`, `test/mcp-integration.test.ts`).

## Live Shells, Hibernation, and Restoration

Named live shells form an LRU working set. When a live slot is needed, the least-recently-used non-busy named shell may be hibernated; busy shells and `default` are protected. If no eligible slot exists, creation fails instead of killing active work (`src/tools/shell/session-manager.ts`). Configuration values are canonical in [Configuration and Startup](./operations/configuration-and-startup.md).

Idle hibernation captures only cwd and exported environment, closes the live shell/process group, and drops command records, transcript state, functions, aliases, and running/background processes. Reusing a still-cached `shell_id` transparently creates a fresh shell restored from cached cwd/environment. Cache expiry uses the manager's shared lifecycle sweep (`src/tools/shell/session-manager.ts`, `src/tools/shell/session.ts`, `src/tools/shell/shell-process.ts`). Caller-visible consequences are canonical in [`shell_run` / `shell_poll`](./tools/shell-run.md).

Cached state is process-local and disappears on MCP restart. If a cached cwd no longer exists when restoration is attempted, that cached state is discarded and the shell starts from its configured baseline instead of entering a failed restart loop (`src/tools/shell/session.ts`, `test/shell-session-manager.test.ts`).

`shell_close` is intentionally destructive: it terminates a non-default live shell, removes any cached state for that ID, and frees its live slot. Automatic idle/LRU hibernation is the only path that preserves cwd/exported environment. `shell_poll` cannot continue old command records after hibernation or close because those records belong to the destroyed live process. `shell_reset` deliberately discards any live or cached recoverable state and starts clean. The `default` shell remains live and protected from explicit close and automatic eviction (`src/tools/shell/session-manager.ts`, `src/tools/shell/shell-tools.ts`).

### Batch Runtime

Caller syntax and result semantics: [shell_run](./tools/shell-run.md).

Internally, one batch remains one outer `(shell_id, request_id)` record. `parallel-runner.ts` owns bounded child scheduling/output, timeout, and process-group cleanup. `parallel-session.ts` owns the batch record lifecycle, grouped retained output/polling, retries, and cancellation. `session.ts` arbitrates access to the persistent shell and captures cwd/exported environment through the process layer before batch children launch. Children are short-lived processes, do not consume named-shell slots, do not mutate persistent/sibling state, and do not cancel siblings on nonzero exit (`src/tools/shell/parallel-runner.ts`, `src/tools/shell/parallel-session.ts`, `src/tools/shell/session.ts`, `src/tools/shell/shell-process.ts`, `src/tools/shell/shell-tools.ts`). Exact caller limits are in [`shell_run` / `shell_poll`](./tools/shell-run.md).

Output can fill a page before single-command completion markers or batch sibling close events arrive. Returning at that point produced avoidable `running` responses for short commands. Both paths now share the same execution wait; status and exit code track execution independently of pagination. Completed work may still return `output_truncated` and a cursor (`src/tools/shell/session.ts`, `test/shell-session.test.ts`, `test/shell-parallel.test.ts`).

## Reset and Recovery

Reset records the stop reason, sends `SIGTERM`, waits up to the configured shell stop grace for child exit, sends `SIGKILL` to the process group, finalizes if close never arrives, and starts a new generation. Shared signaling/escalation mechanics live in `src/child-process-termination.ts`; process state, finalization, and shell generation remain owned by `shell-process.ts` (`src/tools/shell/shell-process.ts`, `src/tools/shell/session.ts`).

Process-group kill failures such as macOS `EPERM` are deliberately swallowed so cleanup cannot crash the MCP server. Cleanup is therefore best effort; descendants may survive when the OS denies signaling (`src/tools/shell/shell-process.ts`, `test/shell-session.test.ts`).

## Related

- [shell_run](./tools/shell-run.md)
- [MCP Tool Surface](./mcp-tool-surface.md)
- [Architecture Map](./architecture-map.md)
- [Workspace Tooling](./workspace-tooling.md)
- [Open Questions and Risks](./project/open-questions-and-risks.md)
