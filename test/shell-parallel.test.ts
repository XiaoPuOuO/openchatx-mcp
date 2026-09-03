import assert from "node:assert/strict"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { MCP_CONFIG } from "../src/config.js"
import { createShellSession, ShellSessionError } from "../src/tools/shell/session.js"
import { isProcessAlive, pollToCompletion, quote, runToCompletion, waitForProcessExit } from "./helpers/shell.js"
import { tempDir } from "./helpers/temp.js"

test("runs parallel command batches from one root with relative paths and retained exported environment", { timeout: 10_000 }, async (t) => {
  const directory = await realpath(await tempDir(t, "shell-mcp-parallel-root-"))
  const repoDirectory = join(directory, "workspace", "repo")
  const apiDirectory = join(repoDirectory, "packages", "api")
  const sharedDirectory = join(directory, "shared")
  await mkdir(apiDirectory, { recursive: true })
  await mkdir(sharedDirectory, { recursive: true })
  const shell = createShellSession({ cwd: directory })
  t.after(() => shell.close())

  await runToCompletion(shell, "parallel-env", "export MCP_PARALLEL_RETAINED=present")
  const batch = await runToCompletion(
    shell,
    "parallel-root",
    [
      { command: `printf 'root:%s:%s' "$PWD" "$MCP_PARALLEL_RETAINED"` },
      { command: `printf 'api:%s:%s' "$PWD" "$MCP_PARALLEL_RETAINED"`, cwd: "./packages/api" },
      { command: `printf 'shared:%s:%s' "$PWD" "$MCP_PARALLEL_RETAINED"`, cwd: "../../shared" },
    ],
    { cwd: "workspace/repo" }
  )

  assert.equal(batch.snapshot.status, "completed")
  assert.equal(batch.snapshot.exit_code, 0)
  assert.deepEqual(
    batch.snapshot.commands?.map(({ run, path, status, exit_code }) => ({ run, path, status, exit_code })),
    [
      { run: 1, path: ".", status: "completed", exit_code: 0 },
      { run: 2, path: "./packages/api", status: "completed", exit_code: 0 },
      { run: 3, path: "../../shared", status: "completed", exit_code: 0 },
    ]
  )
  assert.match(batch.output, /---- run=1 path="\." exit=0 ----/)
  assert.match(batch.output, /---- run=2 path="\.\/packages\/api" exit=0 ----/)
  assert.match(batch.output, /---- run=3 path="\.\.\/\.\.\/shared" exit=0 ----/)
  assert.match(batch.output, new RegExp(`root:${escapeRegExp(repoDirectory)}:present`))
  assert.match(batch.output, /api:.*\/packages\/api:present/)
  assert.match(batch.output, /shared:.*\/shared:present/)

  const after = await runToCompletion(shell, "parallel-root-retained", `printf '%s' "$PWD"`)
  assert.equal(after.output, repoDirectory)
})

test("runs at most six parallel children", { timeout: 10_000 }, async (t) => {
  const directory = await tempDir(t, "shell-mcp-parallel-limit-")
  const releaseFile = join(directory, "release")
  const shell = createShellSession()
  t.after(() => shell.close())

  const commands = Array.from({ length: 6 }, (_, index) => ({
    command: `while [[ ! -e ${quote(releaseFile)} ]]; do sleep 0.01; done; printf ${index + 1}`,
  }))
  const first = await shell.runCommand({
    request_id: "parallel-limit",
    commands,
    wait_ms: 50,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })

  assert.equal(first.status, "running")
  assert.equal(first.commands?.filter((run) => run.status === "running").length, 6)
  assert.equal(first.commands?.filter((run) => run.status === "queued").length, 0)

  await writeFile(releaseFile, "go")
  const completed = await pollToCompletion(shell, first)
  assert.equal(completed.snapshot.status, "completed")
  assert.deepEqual(
    completed.snapshot.commands?.map((run) => run.exit_code),
    [0, 0, 0, 0, 0, 0]
  )
})

test("coalesces completed parallel runs while the batch is still running", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const running = await shell.runCommand({
    request_id: "parallel-coalesced-poll",
    commands: [{ command: "sleep 0.05; printf first" }, { command: "sleep 0.2; printf second" }],
    wait_ms: 0,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.equal(running.status, "running")

  await new Promise((resolve) => setTimeout(resolve, 100))
  const startedAt = Date.now()
  const completed = await shell.pollCommand({
    request_id: "parallel-coalesced-poll",
    cursor: running.next_cursor,
    wait_ms: 1_000,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })

  assert.ok(Date.now() - startedAt >= 50, "poll should not return immediately when only one parallel run has finished")
  assert.equal(completed.status, "completed")
  assert.match(completed.output, /first/)
  assert.match(completed.output, /second/)
})

test("keeps batch concurrency isolated per shell", { timeout: 10_000 }, async (t) => {
  const directory = await tempDir(t, "shell-mcp-parallel-per-shell-")
  const releaseFile = join(directory, "release")
  const firstShell = createShellSession()
  const secondShell = createShellSession()
  t.after(() => Promise.all([firstShell.close(), secondShell.close()]))

  const commands = Array.from({ length: 4 }, () => ({ command: `while [[ ! -e ${quote(releaseFile)} ]]; do sleep 0.01; done` }))
  const [first, second] = await Promise.all([
    firstShell.runCommand({ request_id: "parallel-isolated-first", commands, wait_ms: 50, max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens }),
    secondShell.runCommand({ request_id: "parallel-isolated-second", commands, wait_ms: 50, max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens }),
  ])

  assert.equal(first.commands?.filter((run) => run.status === "running").length, 4)
  assert.equal(second.commands?.filter((run) => run.status === "running").length, 4)

  await writeFile(releaseFile, "go")
  await Promise.all([pollToCompletion(firstShell, first), pollToCompletion(secondShell, second)])
})

test("keeps parallel siblings running when one command exits nonzero", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const batch = await runToCompletion(shell, "parallel-nonzero", [{ command: "false" }, { command: "printf survived", cwd: "./" }])

  assert.equal(batch.snapshot.status, "completed")
  assert.equal(batch.snapshot.exit_code, 1)
  assert.deepEqual(
    batch.snapshot.commands?.map(({ status, exit_code }) => ({ status, exit_code })),
    [
      { status: "completed", exit_code: 1 },
      { status: "completed", exit_code: 0 },
    ]
  )
  assert.match(batch.output, /survived/)
})

test("times out a hung parallel child without blocking its siblings", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession({
    parallelCommandTimeoutMs: 100,
  })
  t.after(() => shell.close())

  const batch = await runToCompletion(shell, "parallel-timeout", [{ command: "sleep 5" }, { command: "printf fast", cwd: "./" }])

  assert.equal(batch.snapshot.status, "completed")
  assert.equal(batch.snapshot.exit_code, 1)
  assert.deepEqual(
    batch.snapshot.commands?.map(({ status, exit_code }) => ({ status, exit_code })),
    [
      { status: "timed_out", exit_code: null },
      { status: "completed", exit_code: 0 },
    ]
  )
  assert.match(batch.output, /---- run=1 path="\." status=timed_out ----/)
  assert.match(batch.output, /---- run=2 path="\.\/" exit=0 ----\n\nfast/)
  assert.match(batch.output, /fast/)
})

test("labels permanently dropped parallel output", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession({
    commandTranscriptBytes: 7,
  })
  t.after(() => shell.close())

  const batch = await runToCompletion(shell, "parallel-output-cap", [{ command: "printf '🙂éAB'" }], { maxOutputTokens: 64 })

  assert.equal(batch.snapshot.dropped_output_bytes, 1)
  assert.match(batch.output, /---- run=1 path="\." exit=0 dropped_bytes=1 ----\n\n🙂éA/)
})

test("inherits the parallel cwd when a run directory is omitted and accepts overrides", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession({ cwd: "/tmp" })
  t.after(() => shell.close())

  const inheritedShellCwd = await runToCompletion(shell, "parallel-inherited-shell-cwd", [{ command: `printf '%s' "$PWD"` }])
  assert.match(inheritedShellCwd.output, new RegExp(`${escapeRegExp(await realpath("/tmp"))}\\n\\n$`))
  assert.equal(inheritedShellCwd.snapshot.commands?.[0]?.path, ".")
  assert.equal(inheritedShellCwd.snapshot.commands?.[0]?.command, `printf '%s' "$PWD"`)

  const inheritedExplicitCwd = await runToCompletion(shell, "parallel-inherited-explicit-cwd", [{ command: `printf '%s' "$PWD"` }], {
    cwd: process.cwd(),
  })
  assert.match(inheritedExplicitCwd.output, new RegExp(`${escapeRegExp(await realpath(process.cwd()))}\\n\\n$`))
  assert.equal(inheritedExplicitCwd.snapshot.commands?.[0]?.path, ".")

  const absolute = await runToCompletion(shell, "parallel-absolute", [{ command: `printf '%s' "$PWD"`, cwd: "/tmp" }])
  assert.match(absolute.output, new RegExp(`${escapeRegExp(await realpath("/tmp"))}\\n\\n$`))
  assert.equal(absolute.snapshot.commands?.[0]?.path, "/tmp")

  await assert.rejects(
    shell.runCommand({
      request_id: "parallel-missing-command",
      wait_ms: 0,
      max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
    } as never),
    (error: unknown) => error instanceof ShellSessionError && error.code === "invalid_command" && /exactly one of command or commands/.test(error.message)
  )
  await assert.rejects(
    shell.runCommand({
      request_id: "parallel-conflicting-command-inputs",
      command: "pwd",
      commands: [{ command: "printf should-not-run" }],
      wait_ms: 0,
      max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
    } as never),
    (error: unknown) => error instanceof ShellSessionError && error.code === "invalid_command" && /exactly one of command or commands/.test(error.message)
  )
  const mixed = await runToCompletion(
    shell,
    "parallel-mixed-directories",
    [{ command: `printf 'root:%s' "$PWD"` }, { command: `printf 'same:%s' "$PWD"`, cwd: "." }, { command: `printf 'tmp:%s' "$PWD"`, cwd: "/tmp" }],
    { cwd: "/tmp" }
  )
  assert.deepEqual(
    mixed.snapshot.commands?.map((run) => run.path),
    [".", ".", "/tmp"]
  )

  const preview = await runToCompletion(shell, "parallel-command-preview", [{ command: "\nprintf command-preview-is-longer-than-limit" }])
  assert.equal(preview.snapshot.commands?.[0]?.command, "printf command-prev…")
})

test("accepts arbitrary multiline zsh in parallel commands", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const batch = await runToCompletion(shell, "parallel-multiline", [
    { command: "printf 'first\\n'\nprintf second" },
    { command: "cat <<'EOF'\n---\n*** Run:\nEOF" },
  ])

  assert.equal(batch.snapshot.status, "completed")
  assert.equal(batch.snapshot.exit_code, 0)
  assert.deepEqual(
    batch.snapshot.commands?.map((run) => run.exit_code),
    [0, 0]
  )
  assert.match(batch.output, /first/)
  assert.match(batch.output, /second/)
  assert.match(batch.output, /---/)
  assert.match(batch.output, /\*\*\* Run:/)
})

test("separates parallel run blocks when command output has no trailing newline", { timeout: 10_000 }, async (t) => {
  const shell = createShellSession()
  t.after(() => shell.close())

  const batch = await runToCompletion(shell, "parallel-output-boundary", [{ command: "printf first" }, { command: "printf second" }])

  assert.match(batch.output, /---- run=1 path="\." exit=0 ----\n\nfirst(?:\n\n|$)/)
  assert.match(batch.output, /---- run=2 path="\." exit=0 ----\n\nsecond(?:\n\n|$)/)
})

test("reset kills running parallel children and retains the batch as reset", { timeout: 10_000 }, async (t) => {
  const directory = await tempDir(t, "shell-mcp-parallel-reset-")
  const pidFile = join(directory, "pid")
  const shell = createShellSession()
  t.after(() => shell.close())

  const running = await shell.runCommand({
    request_id: "parallel-reset",
    cwd: directory,
    commands: [{ command: `printf '%s' "$$" > ${quote(pidFile)}; while :; do sleep 1; done` }],
    wait_ms: 25,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.equal(running.status, "running")
  const pid = await readPid(pidFile)
  assert.equal(isProcessAlive(pid), true)

  await shell.reset({ reason: "test parallel reset" })
  const old = await shell.pollCommand({
    request_id: "parallel-reset",
    cursor: running.next_cursor,
    wait_ms: 0,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.equal(old.status, "reset")
  assert.equal(old.commands?.[0]?.status, "reset")
  assert.match(old.output, /---- run=1 path="\." status=reset ----/)
  assert.equal(await waitForProcessExit(pid), true)
})

test("does not let background descendants escape a completed parallel run", { timeout: 10_000 }, async (t) => {
  const directory = await tempDir(t, "shell-mcp-parallel-background-")
  const pidFile = join(directory, "pid")
  const shell = createShellSession()
  t.after(() => shell.close())

  const batch = await runToCompletion(
    shell,
    "parallel-background",
    [{ command: `(trap '' TERM; while :; do sleep 1; done) & printf '%s' "$!" > ${quote(pidFile)}` }],
    { cwd: directory }
  )
  assert.equal(batch.snapshot.commands?.[0]?.status, "completed")

  const pid = await readPid(pidFile)
  assert.equal(await waitForProcessExit(pid), true)
})

async function readPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const pid = Number.parseInt(await readFile(path, "utf8"), 10)
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`PID file was not created: ${path}`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
