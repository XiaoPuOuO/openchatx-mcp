import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { MCP_CONFIG } from "../src/config.js"
import { createShellSession, type ShellSession } from "../src/tools/shell/session.js"
import { createShellSessionManager } from "../src/tools/shell/session-manager.js"
import { DEFAULT_SHELL_ID } from "../src/tools/shell/shell-contracts.js"
import { runToCompletion, waitForProcessExit } from "./helpers/shell.js"

test("creates named shells lazily and keeps their state isolated", async (t) => {
  const manager = createShellSessionManager()
  t.after(() => manager.close())

  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID])

  const alpha = await manager.getOrCreate("alpha")
  const beta = await manager.getOrCreate("beta")
  assert.notEqual(alpha, beta)
  assert.equal(await manager.getOrCreate("alpha"), alpha)
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID, "alpha", "beta"])

  await alpha.runCommand({
    request_id: "state1",
    command: "cd /tmp && export NAMED_SHELL_STATE=alpha",
    yield_time_ms: MCP_CONFIG.shell.defaultWaitMs,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  const alphaState = await alpha.runCommand({
    request_id: "state2",
    command: `printf '%s|%s' "$PWD" "$NAMED_SHELL_STATE"`,
    yield_time_ms: MCP_CONFIG.shell.defaultWaitMs,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  const betaState = await beta.runCommand({
    request_id: "state2",
    command: `printf '%s|%s' "$PWD" "\${NAMED_SHELL_STATE-unset}"`,
    yield_time_ms: MCP_CONFIG.shell.defaultWaitMs,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })

  assert.equal(alphaState.output, "/tmp|alpha")
  assert.match(betaState.output, /\|unset$/u)
})

test("pressure-evicts the least recently used non-busy named shell", async (t) => {
  let now = 0
  const manager = createShellSessionManager({ maxShells: 3, now: () => now })
  t.after(() => manager.close())

  await manager.getOrCreate("alpha")
  now = 10
  await manager.getOrCreate("beta")
  now = 20
  await manager.getOrCreate("beta")
  now = 30
  await manager.getOrCreate("gamma")

  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID, "beta", "gamma"])
  assert.deepEqual(manager.listCachedShellIds(), ["alpha"])
})

test("lists shells without refreshing their idle timers", async (t) => {
  let now = 0
  const manager = createShellSessionManager({
    idleTimeoutMs: 100,
    now: () => now,
  })
  t.after(() => manager.close())

  await manager.getOrCreate("alpha")
  now = 75
  assert.deepEqual(manager.listShells(), [
    {
      shell_id: DEFAULT_SHELL_ID,
      status: "idle",
      can_close: false,
      idle_ms: 75,
    },
    {
      shell_id: "alpha",
      status: "idle",
      can_close: true,
      idle_ms: 75,
    },
  ])

  now = 100
  assert.deepEqual(await manager.cleanupIdle(), ["alpha"])
})

test("closes named shells and immediately releases their slot", async (t) => {
  const manager = createShellSessionManager({ maxShells: 2 })
  t.after(() => manager.close())

  const alpha = await manager.getOrCreate("alpha")
  await manager.closeShell("alpha")
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID])
  assert.deepEqual(manager.listCachedShellIds(), [])
  await manager.getOrCreate("beta")
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID, "beta"])
  await assert.rejects(
    () => alpha.start(),
    (error: unknown) => error instanceof Error && error.message.includes("closed")
  )
})

test("protects the default shell from close while allowing reset", async (t) => {
  const manager = createShellSessionManager()
  t.after(() => manager.close())

  await assert.rejects(
    () => manager.closeShell(DEFAULT_SHELL_ID),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("cannot be closed") &&
      error.message.includes("shell_reset")
  )

  const reset = await manager.defaultShell.reset({ reason: "test default reset" })
  assert.equal(reset.status, "ready")
  assert.equal(await manager.getOrCreate(DEFAULT_SHELL_ID), manager.defaultShell)
})

test("closing a named shell terminates its active foreground command", async (t) => {
  const manager = createShellSessionManager()
  t.after(() => manager.close())
  const alpha = await manager.getOrCreate("alpha")

  const running = await alpha.runCommand({
    request_id: "long-running",
    command: "sleep 5; printf should-not-complete",
    yield_time_ms: 0,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.equal(running.status, "running")

  await manager.closeShell("alpha")
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID])
  await assert.rejects(
    () => alpha.start(),
    (error: unknown) => error instanceof Error && error.message.includes("closed")
  )
})

test("evicts idle named shells while keeping the default shell", async (t) => {
  let now = 0
  const manager = createShellSessionManager({
    idleTimeoutMs: 100,
    now: () => now,
  })
  t.after(() => manager.close())

  const alpha = await manager.getOrCreate("alpha")
  now = 99
  assert.deepEqual(await manager.cleanupIdle(), [])
  now = 100
  assert.deepEqual(await manager.cleanupIdle(), ["alpha"])
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID])
  assert.deepEqual(manager.listCachedShellIds(now), ["alpha"])
  await manager.getOrCreate("beta")
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID, "beta"])
  await assert.rejects(
    () => alpha.start(),
    (error: unknown) => error instanceof Error && error.message.includes("closed")
  )
})

test("does not evict a named shell while it has active work", async (t) => {
  let now = 0
  const manager = createShellSessionManager({
    idleTimeoutMs: 100,
    now: () => now,
  })
  t.after(() => manager.close())

  const alpha = await manager.getOrCreate("alpha")
  const running = await alpha.runCommand({
    request_id: "active",
    command: "sleep 0.15; printf done",
    yield_time_ms: 0,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.equal(running.status, "running")

  now = 100
  assert.deepEqual(await manager.cleanupIdle(), [])
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID, "alpha"])

  let snapshot = running
  for (let attempt = 0; attempt < 20 && snapshot.status === "running"; attempt += 1) {
    snapshot = await alpha.pollCommand({
      request_id: "active",
      cursor: snapshot.next_cursor,
      yield_time_ms: 100,
      max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
    })
  }
  assert.equal(snapshot.status, "completed")
  now = 199
  assert.deepEqual(await manager.cleanupIdle(), [])
  now = 200
  assert.deepEqual(await manager.cleanupIdle(), ["alpha"])
})

test("closes every created shell", async () => {
  const created: ShellSession[] = []
  const manager = createShellSessionManager({
    createShell: () => {
      const shell = createShellSession()
      created.push(shell)
      return shell
    },
  })
  await manager.getOrCreate("alpha")
  await manager.getOrCreate("beta")

  await manager.close()

  for (const shell of created) {
    await assert.rejects(
      () => shell.start(),
      (error: unknown) => error instanceof Error && error.message.includes("closed")
    )
  }
})

test("restores cwd and exported environment after idle hibernation", async (t) => {
  let now = 0
  const manager = createShellSessionManager({
    idleTimeoutMs: 100,
    cacheTimeoutMs: 10_000,
    now: () => now,
  })
  t.after(() => manager.close())

  const first = await manager.getOrCreate("alpha")
  await runToCompletion(first, "prepare", "cd /tmp && export RESTORED_VALUE=kept")
  now = 100
  assert.deepEqual(await manager.cleanupIdle(), ["alpha"])

  const restored = await manager.getOrCreate("alpha")
  assert.notEqual(restored, first)
  const state = await runToCompletion(restored, "verify", `printf '%s|%s' "$PWD" "$RESTORED_VALUE"`)
  assert.equal(state.output, "/tmp|kept")
})

test("shell_close discards live and cached state", async (t) => {
  const manager = createShellSessionManager({ cacheTimeoutMs: 10_000 })
  t.after(() => manager.close())

  const first = await manager.getOrCreate("alpha")
  await runToCompletion(first, "prepare-close", "cd /tmp && export CLOSE_VALUE=kept")
  await manager.closeShell("alpha")

  assert.deepEqual(manager.listCachedShellIds(), [])
  const fresh = await manager.getOrCreate("alpha")
  const state = await runToCompletion(
    fresh,
    "after-close",
    `printf '%s|%s' "$PWD" "\${CLOSE_VALUE-unset}"`
  )
  assert.match(state.output, /\|unset$/u)
  assert.notEqual(state.output, "/tmp|kept")
})

test("expires cached logical shell state after cache TTL", async (t) => {
  let now = 0
  const manager = createShellSessionManager({
    idleTimeoutMs: 100,
    cacheTimeoutMs: 1_000,
    now: () => now,
  })
  t.after(() => manager.close())

  const alpha = await manager.getOrCreate("alpha")
  await runToCompletion(alpha, "cache-expire", "cd /tmp && export EXPIRES=yes")
  now = 100
  await manager.cleanupIdle()
  now = 1_000
  await manager.cleanupIdle()
  assert.deepEqual(manager.listCachedShellIds(now), [])

  const fresh = await manager.getOrCreate("alpha")
  const state = await runToCompletion(
    fresh,
    "fresh-state",
    `printf '%s|%s' "$PWD" "\${EXPIRES-unset}"`
  )
  assert.match(state.output, /\|unset$/u)
  assert.notEqual(state.output, "/tmp|yes")
})

test("never pressure-evicts busy shells and blocks when no evictable slot exists", async (t) => {
  const manager = createShellSessionManager({ maxShells: 2 })
  t.after(() => manager.close())
  const alpha = await manager.getOrCreate("alpha")
  const running = await alpha.runCommand({
    request_id: "busy-capacity",
    command: "sleep 0.2",
    yield_time_ms: 0,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.equal(running.status, "running")

  await assert.rejects(
    () => manager.getOrCreate("beta"),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("shell slots are unavailable") &&
      error.message.includes("never pressure-evicted")
  )
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID, "alpha"])
})

test("pressure eviction skips a busy older shell and evicts the next LRU shell", async (t) => {
  let now = 0
  const manager = createShellSessionManager({ maxShells: 3, now: () => now })
  t.after(() => manager.close())
  const alpha = await manager.getOrCreate("alpha")
  now = 10
  await manager.getOrCreate("beta")
  const running = await alpha.runCommand({
    request_id: "busy-lru",
    command: "sleep 0.2",
    yield_time_ms: 0,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.equal(running.status, "running")

  now = 20
  await manager.getOrCreate("gamma")
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID, "alpha", "gamma"])
  assert.deepEqual(manager.listCachedShellIds(), ["beta"])
})

test("hibernation restores only cwd and exported environment and terminates background processes", async (t) => {
  let now = 0
  const manager = createShellSessionManager({
    idleTimeoutMs: 100,
    cacheTimeoutMs: 10_000,
    now: () => now,
  })
  t.after(() => manager.close())
  const alpha = await manager.getOrCreate("alpha")
  const prepared = await runToCompletion(
    alpha,
    "limited-state",
    "cd /tmp; export PERSISTED_VALUE=yes; LOCAL_ONLY=hidden; function __mcp_ephemeral_fn { printf no; }; sleep 30 & printf '%s' $!"
  )
  const backgroundPid = Number(prepared.output)
  assert.ok(Number.isSafeInteger(backgroundPid) && backgroundPid > 0)

  now = 100
  assert.deepEqual(await manager.cleanupIdle(), ["alpha"])
  assert.equal(await waitForProcessExit(backgroundPid), true)

  const restored = await manager.getOrCreate("alpha")
  const state = await runToCompletion(
    restored,
    "limited-state-check",
    `printf '%s|%s|' "$PERSISTED_VALUE" "\${LOCAL_ONLY-unset}"; if (( $+functions[__mcp_ephemeral_fn] )); then printf present; else printf missing; fi`
  )
  assert.equal(state.output, "yes|unset|missing")
})

test("resetting a cached shell discards cached cwd and environment", async (t) => {
  let now = 0
  const manager = createShellSessionManager({
    idleTimeoutMs: 100,
    cacheTimeoutMs: 10_000,
    now: () => now,
  })
  t.after(() => manager.close())
  const alpha = await manager.getOrCreate("alpha")
  await runToCompletion(alpha, "prepare-reset-cache", "cd /tmp && export RESET_CACHE_VALUE=kept")
  now = 100
  await manager.cleanupIdle()
  assert.deepEqual(manager.listCachedShellIds(), ["alpha"])

  await manager.withShell("alpha", (shell) => shell.reset({ reason: "test cached reset" }), {
    restoreCached: false,
  })
  const live = manager.getExisting("alpha")
  const state = await runToCompletion(
    live,
    "after-reset-cache",
    `printf '%s|%s' "$PWD" "\${RESET_CACHE_VALUE-unset}"`
  )
  assert.match(state.output, /\|unset$/u)
  assert.notEqual(state.output, "/tmp|kept")
})

test("invalid cached cwd falls back to a clean baseline instead of restart-looping", async (t) => {
  let now = 0
  const temporaryCwd = await mkdtemp(join(tmpdir(), "mcp-cached-cwd-"))
  const manager = createShellSessionManager({
    idleTimeoutMs: 100,
    cacheTimeoutMs: 10_000,
    now: () => now,
  })
  t.after(() => manager.close())
  const alpha = await manager.getOrCreate("alpha")
  await runToCompletion(
    alpha,
    "prepare-missing-cwd",
    `cd ${JSON.stringify(temporaryCwd)} && export MISSING_CWD_VALUE=kept`
  )
  now = 100
  await manager.cleanupIdle()
  await rm(temporaryCwd, { recursive: true, force: true })

  const restored = await manager.getOrCreate("alpha")
  const state = await runToCompletion(
    restored,
    "missing-cwd-fallback",
    `printf '%s|%s' "$PWD" "\${MISSING_CWD_VALUE-unset}"`
  )
  assert.match(state.output, /\|unset$/u)
  assert.notEqual(state.output, `${temporaryCwd}|kept`)
})

test("keeps a live shell when recoverable-state capture fails during pressure eviction", async (t) => {
  const manager = createShellSessionManager({
    maxShells: 2,
    createShell: () => {
      const shell = createShellSession()
      shell.captureRecoverableState = async () => {
        throw new Error("capture failed")
      }
      return shell
    },
  })
  t.after(() => manager.close())

  const alpha = await manager.getOrCreate("alpha")
  await assert.rejects(
    () => manager.getOrCreate("beta"),
    (error: unknown) =>
      error instanceof Error && error.message.includes("shell slots are unavailable")
  )
  assert.equal(await manager.getOrCreate("alpha"), alpha)
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID, "alpha"])
  assert.deepEqual(manager.listCachedShellIds(), [])
})
