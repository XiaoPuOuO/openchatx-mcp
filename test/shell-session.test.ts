import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { MCP_CONFIG } from "../src/config.js"
import { countTokens } from "../src/tokenizer.js"
import {
  createShellSession,
  ShellSessionError,
  type ShellSnapshot,
} from "../src/tools/shell/session.js"
import {
  isProcessAlive,
  pollToCompletion,
  quote,
  runToCompletion,
  waitForProcessExit,
} from "./helpers/shell.js"
import { tempDir } from "./helpers/temp.js"

test("returns short stdout and stderr before completion without duplicate polls", {
  timeout: 10_000,
}, async (t) => {
  const directory = await tempDir(t, "shell-mcp-incremental-")
  const nextFile = join(directory, "next")
  const finishFile = join(directory, "finish")
  const shell = createShellSession()
  t.after(() => shell.close())

  const first = await shell.runCommand({
    request_id: "incremental-output",
    command: [
      "printf 'READY🙂\\n'",
      "printf 'WARN\\n' >&2",
      `while [[ ! -e ${quote(nextFile)} ]]; do sleep 0.01; done`,
      "printf NEXT",
      `while [[ ! -e ${quote(finishFile)} ]]; do sleep 0.01; done`,
      "printf DONE",
    ].join("\n"),
    yield_time_ms: 200,
    max_output_tokens: 64,
  })
  assert.equal(first.status, "running")
  assert.equal(first.exit_code, null)
  assert.equal(first.output, "READY🙂\nWARN\n")

  const idle = await shell.pollCommand({
    request_id: first.request_id,
    cursor: first.next_cursor,
    yield_time_ms: 20,
    max_output_tokens: 64,
  })
  assert.equal(idle.status, "running")
  assert.equal(idle.output, "")
  assert.equal(idle.next_cursor, first.next_cursor)

  await writeFile(nextFile, "go")
  const second = await shell.pollCommand({
    request_id: first.request_id,
    cursor: idle.next_cursor,
    yield_time_ms: 200,
    max_output_tokens: 64,
  })
  assert.equal(second.status, "running")
  assert.equal(second.output, "NEXT")

  await writeFile(finishFile, "go")
  const completed = await pollToCompletion(shell, second)
  assert.equal(completed.snapshot.status, "completed")
  assert.equal(completed.snapshot.exit_code, 0)
  assert.equal(first.output + completed.output, "READY🙂\nWARN\nNEXTDONE")
})

test("holds only a possible marker prefix while streaming ordinary output", {
  timeout: 10_000,
}, async (t) => {
  const directory = await tempDir(t, "shell-mcp-marker-prefix-")
  const nextFile = join(directory, "next")
  const finishFile = join(directory, "finish")
  const shell = createShellSession()
  t.after(() => shell.close())

  const first = await shell.runCommand({
    request_id: "incremental-marker-prefix",
    command: [
      "printf 'before\\036__MCP_DONE_'",
      `while [[ ! -e ${quote(nextFile)} ]]; do sleep 0.01; done`,
      "printf 'not-a-token🙂'",
      `while [[ ! -e ${quote(finishFile)} ]]; do sleep 0.01; done`,
    ].join("\n"),
    yield_time_ms: 200,
    max_output_tokens: 64,
  })
  assert.equal(first.status, "running")
  assert.equal(first.output, "before")

  await writeFile(nextFile, "go")
  const second = await shell.pollCommand({
    request_id: first.request_id,
    cursor: first.next_cursor,
    yield_time_ms: 200,
    max_output_tokens: 64,
  })
  assert.equal(second.status, "running")
  assert.equal(second.output, "\u001e__MCP_DONE_not-a-token🙂")

  await writeFile(finishFile, "go")
  const completed = await pollToCompletion(shell, second)
  assert.equal(completed.snapshot.status, "completed")
  assert.equal(first.output + completed.output, "before\u001e__MCP_DONE_not-a-token🙂")
})

test("retains cwd and environment across commands", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-state-"))
  const shell = createShellSession()
  t.after(async () => {
    await shell.close()
    await rm(directory, { recursive: true, force: true })
  })

  const first = await runToCompletion(
    shell,
    "state-1",
    `cd ${quote(directory)}; export MCP_RETAINED=present`
  )
  assert.equal(first.snapshot.exit_code, 0)

  const second = await runToCompletion(shell, "state-2", `printf '%s|%s' "$PWD" "$MCP_RETAINED"`)
  assert.equal(second.output, `${directory}|present`)
  assert.equal(second.snapshot.exit_code, 0)
})

test("preserves the parent PATH without login-shell startup rewriting it", {
  timeout: 10_000,
}, async (t) => {
  const zdotdir = await tempDir(t, "shellby-zdotdir-")
  const expectedPath = `/tmp/shellby-path-${Date.now()}`
  await writeFile(join(zdotdir, ".zshenv"), 'export PATH="/tmp/zsh-startup:$PATH"\n')
  const shell = createShellSession({
    env: { ...process.env, PATH: expectedPath, ZDOTDIR: zdotdir },
  })
  t.after(() => shell.close())

  const result = await runToCompletion(shell, "preserve-parent-path", `printf '%s' "$PATH"`)
  assert.equal(result.output, expectedPath)

  const parallel = await runToCompletion(shell, "preserve-parent-path-parallel", [
    { command: `printf '%s' "$PATH"` },
  ])
  assert.match(parallel.output, new RegExp(expectedPath))
  assert.doesNotMatch(parallel.output, /zsh-startup/u)
})

test("starts in an explicit cwd, reports it, and retains it", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-explicit-cwd-"))
  const shell = createShellSession()
  t.after(async () => {
    await shell.close()
    await rm(directory, { recursive: true, force: true })
  })

  const first = await runToCompletion(shell, "explicit-cwd", "printf '%s' \"$PWD\"", {
    cwd: directory,
  })
  assert.equal(first.output, directory)
  assert.equal(first.snapshot.cwd, directory)

  const second = await runToCompletion(shell, "retained-explicit-cwd", "printf '%s' \"$PWD\"")
  assert.equal(second.output, directory)
  assert.equal(second.snapshot.cwd, directory)
})

test("resolves relative explicit cwd from the retained shell cwd", {
  timeout: 10_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-relative-cwd-"))
  const childDirectory = join(directory, "child")
  await mkdir(childDirectory)
  const shell = createShellSession({ cwd: directory })
  t.after(async () => {
    await shell.close()
    await rm(directory, { recursive: true, force: true })
  })

  const child = await runToCompletion(shell, "relative-child", `printf '%s' "$PWD"`, {
    cwd: "./child",
  })
  assert.equal(child.output, childDirectory)
  assert.equal(child.snapshot.cwd, childDirectory)

  const parent = await runToCompletion(shell, "relative-parent", `printf '%s' "$PWD"`, {
    cwd: "..",
  })
  assert.equal(parent.output, directory)
  assert.equal(parent.snapshot.cwd, directory)
})

test("rejects invalid explicit working directories", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-invalid-cwd-"))
  const file = join(directory, "file.txt")
  await writeFile(file, "not a directory")
  const shell = createShellSession()
  t.after(async () => {
    await shell.close()
    await rm(directory, { recursive: true, force: true })
  })

  await assert.rejects(
    shell.runCommand({
      request_id: "missing-cwd",
      command: "printf blocked",
      cwd: "missing/path",
      yield_time_ms: 0,
      max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
    }),
    (error: unknown) =>
      error instanceof ShellSessionError &&
      error.code === "invalid_command" &&
      /not accessible/u.test(error.message)
  )

  await assert.rejects(
    shell.runCommand({
      request_id: "file-cwd",
      command: "printf blocked",
      cwd: file,
      yield_time_ms: 0,
      max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
    }),
    (error: unknown) =>
      error instanceof ShellSessionError &&
      error.code === "invalid_command" &&
      /not a directory/u.test(error.message)
  )
})

test("isolates protocol stdin and restores redirected descriptors", {
  timeout: 10_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-fds-"))
  const redirected = join(directory, "redirected.txt")
  const shell = createShellSession()
  t.after(async () => {
    await shell.close()
    await rm(directory, { recursive: true, force: true })
  })

  const catResult = await runToCompletion(shell, "stdin", "cat; printf protocol-safe")
  assert.equal(catResult.output, "protocol-safe")

  const redirectResult = await runToCompletion(
    shell,
    "redirect",
    `exec >${quote(redirected)}; printf hidden`
  )
  assert.equal(redirectResult.output, "")
  assert.equal(await readFile(redirected, "utf8"), "hidden")

  const after = await runToCompletion(shell, "after-redirect", "printf visible")
  assert.equal(after.output, "visible")
})

test("deduplicates retries and rejects request id conflicts", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-dedupe-"))
  const outputFile = join(directory, "count.txt")
  const shell = createShellSession()
  t.after(async () => {
    await shell.close()
    await rm(directory, { recursive: true, force: true })
  })

  const command = `printf x >> ${quote(outputFile)}`
  await runToCompletion(shell, "dedupe", command)
  await runToCompletion(shell, "dedupe", command)
  assert.equal(await readFile(outputFile, "utf8"), "x")

  await assert.rejects(
    shell.runCommand({
      request_id: "dedupe",
      command: "printf different",
      yield_time_ms: 0,
      max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
    }),
    (error: unknown) => error instanceof ShellSessionError && error.code === "request_conflict"
  )
})

test("does not leak errexit into later commands", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  await runToCompletion(shell, "enable-errexit", "set -e")
  const after = await runToCompletion(shell, "after-errexit", "false; printf survived")

  assert.equal(after.output, "survived")
  assert.equal(after.snapshot.exit_code, 0)
})

test("keeps a completed retry bounded after later commands", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const first = await runToCompletion(shell, "bounded-retry", "printf first")
  await runToCompletion(shell, "later-command", "printf later")

  const retry = await shell.runCommand({
    request_id: "bounded-retry",
    command: "printf first",
    yield_time_ms: 0,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.equal(retry.output, "first")
  assert.equal(retry.next_cursor, first.snapshot.next_cursor)
  assert.equal(retry.output_truncated, false)
})

test("admits only one concurrent command without corrupting the active record", {
  timeout: 10_000,
}, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const commands = new Map([
    ["concurrent-a", "sleep 0.1; printf A"],
    ["concurrent-b", "sleep 0.1; printf B"],
  ])
  const attempts = await Promise.allSettled(
    [...commands].map(([requestId, command]) =>
      shell.runCommand({
        request_id: requestId,
        command,
        yield_time_ms: 0,
        max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
      })
    )
  )
  const admitted = attempts.filter(
    (result): result is PromiseFulfilledResult<ShellSnapshot> => result.status === "fulfilled"
  )
  const rejected = attempts.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  )

  assert.equal(admitted.length, 1)
  assert.equal(rejected.length, 1)
  const admittedAttempt = admitted[0]
  const rejectedAttempt = rejected[0]
  assert.ok(admittedAttempt)
  assert.ok(rejectedAttempt)
  assert.ok(
    rejectedAttempt.reason instanceof ShellSessionError && rejectedAttempt.reason.code === "busy"
  )

  const completed = await pollToCompletion(shell, admittedAttempt.value)
  const expectedOutput = admittedAttempt.value.request_id === "concurrent-a" ? "A" : "B"
  assert.equal(completed.output, expectedOutput)
  assert.equal(completed.snapshot.status, "completed")

  const next = await runToCompletion(shell, "after-concurrent", "printf clean")
  assert.equal(next.output, "clean")
})

test("polls bounded output without duplicates", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const expected = "0".repeat(2_000)
  const result = await runToCompletion(shell, "chunks", "printf '%02000d' 0", {
    maxOutputTokens: 64,
  })
  assert.equal(result.output, expected)
  assert.equal(result.snapshot.status, "completed")
  assert.equal(result.snapshot.exit_code, 0)
})

test("caps o200k tokens without splitting characters and allows an override", {
  timeout: 10_000,
}, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const expected = "🙂éA".repeat(100)
  const first = await shell.runCommand({
    request_id: "token-cap",
    command: `printf '${expected}'; sleep 0.1; (exit 7)`,
    yield_time_ms: 1_000,
    max_output_tokens: 64,
  })
  assert.equal(expected.startsWith(first.output), true)
  assert.ok(first.output.length > 0)
  assert.ok(countTokens(first.output) <= 64)
  assert.equal(first.output_truncated, true)
  assert.equal(first.status, "completed")
  assert.equal(first.exit_code, 7)

  let output = first.output
  let snapshot = first
  for (
    let attempt = 0;
    attempt < 10 && (snapshot.status === "running" || snapshot.output_truncated);
    attempt += 1
  ) {
    snapshot = await shell.pollCommand({
      request_id: "token-cap",
      cursor: snapshot.next_cursor,
      yield_time_ms: 100,
      max_output_tokens: 512,
    })
    assert.ok(countTokens(snapshot.output) <= 512)
    assert.equal(snapshot.status, "completed")
    assert.equal(snapshot.exit_code, 7)
    output += snapshot.output
  }
  assert.equal(output, expected)
  assert.equal(snapshot.status, "completed")
  assert.equal(snapshot.output_truncated, false)
})

test("single-command retries and polls honor the wait even with a full output page", {
  timeout: 10_000,
}, async (t) => {
  const directory = await tempDir(t, "shell-mcp-output-wait-")
  const releaseFile = join(directory, "release")
  const shell = createShellSession()
  t.after(() => shell.close())
  const input = {
    request_id: "single-truncated-wait",
    command: `printf '%s' ${quote("output line\n".repeat(1_000))}; while [[ ! -e ${quote(releaseFile)} ]]; do sleep 0.01; done; printf released`,
    yield_time_ms: 200,
    max_output_tokens: 64,
  }
  const first = await shell.runCommand(input)
  assert.equal(first.status, "running")
  assert.equal(first.output_truncated, true)

  const retryStartedAt = Date.now()
  const retry = await shell.runCommand({ ...input, yield_time_ms: 80 })
  assert.ok(Date.now() - retryStartedAt >= 50, "unread output must not end a retry's wait")
  assert.equal(retry.status, "running")
  assert.equal(retry.exit_code, null)

  const pollStartedAt = Date.now()
  const waiting = await shell.pollCommand({
    request_id: input.request_id,
    cursor: first.next_cursor,
    yield_time_ms: 80,
    max_output_tokens: 64,
  })
  assert.ok(Date.now() - pollStartedAt >= 50, "unread output must not end a poll's wait")
  assert.equal(waiting.status, "running")
  assert.equal(waiting.exit_code, null)
  assert.equal(waiting.output_truncated, true)

  await writeFile(releaseFile, "go")
  const completed = await shell.pollCommand({
    request_id: input.request_id,
    cursor: waiting.next_cursor,
    yield_time_ms: 1_000,
    max_output_tokens: 64,
  })
  assert.equal(completed.status, "completed")
  assert.equal(completed.exit_code, 0)
  assert.equal(completed.output_truncated, true)
  assert.equal(shell.hasActiveWork, false)
})

test("drops output beyond the per-command transcript ceiling", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession({
    commandTranscriptBytes: 7,
  })
  t.after(() => shell.close())

  const result = await runToCompletion(shell, "command-transcript-cap", "printf '🙂éAB'")
  assert.equal(result.output, "🙂éA")
  assert.equal(result.snapshot.output_dropped, true)
  assert.equal(result.snapshot.dropped_output_bytes, 1)

  const after = await runToCompletion(shell, "after-command-transcript-cap", "printf healthy")
  assert.equal(after.output, "healthy")
  assert.equal(after.snapshot.output_dropped, false)
  assert.equal(after.snapshot.dropped_output_bytes, 0)
})

test("keeps surrogate pairs intact while scanning for a delayed marker", {
  timeout: 10_000,
}, async (t) => {
  const shell = createShellSession({
    commandTranscriptBytes: 4,
  })
  t.after(() => shell.close())

  const result = await runToCompletion(
    shell,
    "surrogate-marker-boundary",
    `printf '${"🙂"}${"a".repeat(45)}'; sleep 0.1`
  )

  assert.equal(result.output, "🙂")
  assert.equal(result.snapshot.output_dropped, true)
  assert.equal(result.snapshot.dropped_output_bytes, 45)
})

test("drops a whole surrogate pair at the rolling transcript boundary", {
  timeout: 10_000,
}, async (t) => {
  const shell = createShellSession({
    transcriptLimit: 1,
  })
  t.after(() => shell.close())

  const evicted = await runToCompletion(shell, "surrogate-transcript-boundary", "printf '🙂'")
  assert.equal(evicted.output, "")
  assert.equal(evicted.snapshot.cursor_expired, true)

  const after = await runToCompletion(shell, "after-surrogate-transcript-boundary", "printf A")
  assert.equal(after.output, "A")
})

test("preserves rolling transcript cursors across repeated overflow", {
  timeout: 10_000,
}, async (t) => {
  const shell = createShellSession({
    transcriptLimit: 64,
    commandTranscriptBytes: 512,
  })
  t.after(() => shell.close())

  const first = await runToCompletion(shell, "overflow-0", `printf '00:${"x".repeat(12)}'`)
  const firstCursor = first.snapshot.next_cursor

  for (let index = 1; index < 20; index += 1) {
    await runToCompletion(
      shell,
      `overflow-${index}`,
      `printf '${String(index).padStart(2, "0")}:${"x".repeat(12)}'`
    )
  }

  const latest = await runToCompletion(shell, "overflow-latest", "printf latest")
  assert.equal(latest.output, "latest")
  assert.equal(latest.snapshot.cursor_expired, false)

  const stale = await shell.pollCommand({
    request_id: "overflow-0",
    cursor: firstCursor,
    yield_time_ms: 0,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.equal(stale.cursor_expired, true)
})

test("contains readonly wrapper variables to one command", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const poisoned = await runToCompletion(
    shell,
    "readonly-wrapper-variable",
    "readonly __mcp_command; printf contained"
  )
  assert.equal(poisoned.output, "contained")
  assert.equal(poisoned.snapshot.status, "completed")

  const after = await runToCompletion(shell, "after-readonly-wrapper-variable", "printf healthy")
  assert.equal(after.output, "healthy")
})

test("waits for a quick command to complete instead of returning on its first output", {
  timeout: 10_000,
}, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const result = await shell.runCommand({
    request_id: "wait-for-completion",
    command: "printf first; sleep 0.05; printf second",
    yield_time_ms: 1_000,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })

  assert.equal(result.status, "completed")
  assert.equal(result.output, "firstsecond")
  assert.equal(result.exit_code, 0)
})

test("keeps completed command polling bounded after later commands", {
  timeout: 10_000,
}, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const first = await runToCompletion(shell, "poll-boundary-first", "printf first")
  await runToCompletion(shell, "poll-boundary-second", "printf second")

  const stalePoll = await shell.pollCommand({
    request_id: "poll-boundary-first",
    cursor: first.snapshot.next_cursor,
    yield_time_ms: 0,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })

  assert.equal(stalePoll.output, "")
  assert.equal(stalePoll.output_truncated, false)
})

test("rejects poll cursors before the requested command", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  await runToCompletion(shell, "poll-before-first", "printf first-secret")
  await runToCompletion(shell, "poll-before-second", "printf second")

  await assert.rejects(
    shell.pollCommand({
      request_id: "poll-before-second",
      cursor: 0,
      yield_time_ms: 0,
      max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
    }),
    (error: unknown) => error instanceof ShellSessionError && error.code === "invalid_cursor"
  )
})

test("coalesces foreground output while a command is still running", {
  timeout: 10_000,
}, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const running = await shell.runCommand({
    request_id: "coalesced-foreground",
    command: "sleep 0.05; printf first; sleep 0.15; printf second",
    yield_time_ms: 0,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.equal(running.status, "running")

  await new Promise((resolve) => setTimeout(resolve, 100))
  const startedAt = Date.now()
  const completed = await shell.pollCommand({
    request_id: "coalesced-foreground",
    cursor: running.next_cursor,
    yield_time_ms: 1_000,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.ok(
    Date.now() - startedAt >= 50,
    "poll should not return immediately just because unread output exists"
  )
  assert.equal(completed.status, "completed")
  assert.equal(completed.output, "firstsecond")
})

test("handles multiline commands, quotes, and redirected background output", {
  timeout: 10_000,
}, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const quoted = await runToCompletion(
    shell,
    "quoted",
    ["value=$(cat <<'VALUE_EOF'", "a'b", "VALUE_EOF", ")", `printf '%s' "$value"`].join("\n")
  )
  assert.equal(quoted.output, "a'b")

  const backgroundFile = `/tmp/chatgpt-shell-background-${process.pid}`
  const background = await shell.runCommand({
    request_id: "background",
    command: `(sleep 0.1; printf background-finished > ${quote(backgroundFile)}) &`,
    yield_time_ms: 500,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.equal(background.status, "completed")
  const readBackground = await runToCompletion(
    shell,
    "background-output",
    `for _ in {1..200}; do [[ -s ${quote(backgroundFile)} ]] && break; sleep 0.01; done; [[ -s ${quote(backgroundFile)} ]] || exit 1; value=$(<${quote(backgroundFile)}); rm ${quote(backgroundFile)}; printf '%s' "$value"`
  )
  assert.equal(readBackground.output, "background-finished")
})

test("reports shell loss and automatically starts a clean generation", {
  timeout: 10_000,
}, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  await runToCompletion(shell, "before-exit", "printf initial")
  const exited = await runToCompletion(shell, "exit-shell", "exit 7")
  assert.equal(exited.snapshot.status, "shell_exited")

  const recovered = await runToCompletion(shell, "after-exit", "printf recovered")
  assert.equal(recovered.output, "recovered")
  assert.equal(recovered.snapshot.status, "completed")
})

test("recovers when process-group cleanup is denied", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const originalKill = process.kill
  let injected = false
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (!injected && pid < 0 && signal === "SIGKILL") {
      injected = true
      const error = new Error("kill EPERM") as NodeJS.ErrnoException
      error.code = "EPERM"
      throw error
    }
    return originalKill(pid, signal)
  }) as typeof process.kill

  let exited: Awaited<ReturnType<typeof runToCompletion>>
  try {
    exited = await runToCompletion(shell, "eperm-exit", "exit 7")
  } finally {
    process.kill = originalKill
  }

  assert.equal(injected, true)
  assert.equal(exited.snapshot.status, "shell_exited")
  const recovered = await runToCompletion(shell, "after-eperm", "printf recovered")
  assert.equal(recovered.output, "recovered")
})

test("reset cancels a stuck command and creates a clean shell", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const running = await shell.runCommand({
    request_id: "stuck",
    command: "export SHOULD_DISAPPEAR=yes; sleep 30",
    yield_time_ms: 25,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.equal(running.status, "running")

  const reset = await shell.reset({ reason: "test reset" })
  assert.equal(reset.status, "ready")

  const old = await shell.pollCommand({
    request_id: "stuck",
    cursor: running.next_cursor,
    yield_time_ms: 0,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.equal(old.status, "reset")

  const recovered = await runToCompletion(
    shell,
    "after-reset",
    "printf '%s' \"${SHOULD_DISAPPEAR-unset}\""
  )
  assert.equal(recovered.output, "unset")
})

test("reset kills a TERM-resistant background descendant", { timeout: 10_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("process-group signaling is POSIX-specific")
    return
  }

  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-resistant-"))
  const readyFile = join(directory, "ready")
  const shell = createShellSession()
  // biome-ignore lint/style/useConst: assigned after cleanup registration so early failures can still clean up the old process group.
  let descendantPid: number | undefined
  let oldProcessGroup: number | undefined
  t.after(async () => {
    await shell.close()
    if (oldProcessGroup && isProcessAlive(-oldProcessGroup)) {
      try {
        process.kill(-oldProcessGroup, "SIGKILL")
      } catch (error) {
        if (!isMissingProcess(error)) throw error
      }
    }
    await rm(directory, { recursive: true, force: true })
  })

  const started = await runToCompletion(
    shell,
    "resistant-background",
    [
      `(trap '' TERM; printf ready > ${quote(readyFile)}; while :; do sleep 1; done) &`,
      "descendant=$!",
      `while [[ ! -s ${quote(readyFile)} ]]; do sleep 0.01; done`,
      `printf '%s|%s' "$descendant" "$$"`,
    ].join("; ")
  )
  ;[descendantPid, oldProcessGroup] = started.output
    .split("|")
    .map((value) => Number.parseInt(value, 10))
  assert.ok(descendantPid !== undefined && Number.isSafeInteger(descendantPid))
  assert.ok(oldProcessGroup !== undefined && Number.isSafeInteger(oldProcessGroup))
  assert.equal(isProcessAlive(descendantPid), true)
  assert.equal(isProcessAlive(-oldProcessGroup), true)

  await shell.reset({ reason: "kill resistant descendant" })

  assert.equal(await waitForProcessExit(descendantPid), true)
  assert.equal(await waitForProcessExit(-oldProcessGroup), true)
})

function isMissingProcess(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH"
  )
}
