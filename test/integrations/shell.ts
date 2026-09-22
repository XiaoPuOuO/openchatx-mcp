import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createShellSession } from "../../src/tools/shell/session.js"
import { createShellSessionManager } from "../../src/tools/shell/session-manager.js"
import {
  callUntilComplete,
  connectClient,
  snapshotFromResult,
  startMcpHttpServer,
  toolText,
} from "./helpers.js"

const APPLY_PATCH_TOOL_GUIDANCE =
  "`apply_patch` is a separate MCP tool and cannot be used through `shell_run`. For local file changes, including creating, updating, deleting, moving, or renaming files, use the `apply_patch` MCP tool directly."

test("redirects missing apply_patch commands to the native tool in normal and batch output", {
  timeout: 20_000,
}, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "apply-patch-shell-hint-client")
  t.after(() => connected.client.close())

  const normal = await callUntilComplete(
    connected.client,
    "missing-apply-patch",
    "PATH=/nonexistent apply_patch"
  )
  assert.doesNotMatch(normal.output, /command not found: apply_patch/u)
  assert.equal(normal.output, APPLY_PATCH_TOOL_GUIDANCE)

  const batch = await callUntilComplete(connected.client, "missing-apply-patch-batch", [
    { command: "PATH=/nonexistent apply_patch" },
    { command: "PATH=/nonexistent apply_patch" },
    { command: "printf batch-ok" },
  ])
  assert.doesNotMatch(batch.output, /command not found: apply_patch/u)
  assert.ok(batch.output.includes(APPLY_PATCH_TOOL_GUIDANCE))
  assert.equal(batch.output.split(APPLY_PATCH_TOOL_GUIDANCE).length - 1, 1)
  assert.match(batch.output, /batch-ok/u)
})

test("retains default shell state across MCP client sessions", { timeout: 20_000 }, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())

  const first = await connectClient(running.url, "shell-state-client-1")
  const initialized = await callUntilComplete(
    first.client,
    "state-init",
    "cd /tmp && export MCP_HTTP_RETAINED=yes && printf initialized"
  )
  assert.equal(initialized.output, "initialized")
  assert.equal(initialized.cwd, "/tmp")
  await first.client.close()

  const second = await connectClient(running.url, "shell-state-client-2")
  t.after(() => second.client.close())
  const retained = await callUntilComplete(
    second.client,
    "state-read",
    `printf '%s|%s' "$PWD" "$MCP_HTTP_RETAINED"`
  )
  assert.equal(retained.output, "/tmp|yes")
  assert.equal(retained.cwd, "/tmp")
})

test("isolates named shells and allows independent foreground work", {
  timeout: 20_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-named-shells-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "named-shell-client")
  t.after(() => connected.client.close())

  await callUntilComplete(
    connected.client,
    "alpha-state",
    "export NAMED_STATE=alpha && printf alpha-ready",
    "alpha"
  )
  const beta = await callUntilComplete(
    connected.client,
    "beta-state",
    "printf '%s' \"${NAMED_STATE-unset}\"",
    "beta"
  )
  assert.equal(beta.output, "unset")

  const release = join(root, "release")
  const slowCommand = `while [[ ! -e ${JSON.stringify(release)} ]]; do sleep 0.01; done; printf alpha-done`
  const started = snapshotFromResult(
    await connected.client.callTool({
      name: "shell_run",
      arguments: {
        shell_id: "alpha",
        request_id: "alpha-slow",
        command: slowCommand,
        yield_time_ms: 0,
      },
    })
  )
  assert.equal(started.status, "running")

  assert.equal(
    (await callUntilComplete(connected.client, "beta-fast", "printf beta-done", "beta")).output,
    "beta-done"
  )

  const busy = await connected.client.callTool({
    name: "shell_run",
    arguments: { shell_id: "alpha", request_id: "alpha-blocked", command: "printf should-not-run" },
  })
  assert.equal(busy.isError, true)
  assert.match(JSON.stringify(busy.content), /busy/u)

  await writeFile(release, "go")
  assert.equal(
    (await callUntilComplete(connected.client, "alpha-slow", slowCommand, "alpha")).output,
    "alpha-done"
  )

  const listed = await connected.client.callTool({ name: "shell_list", arguments: {} })
  const shellIds = [...toolText(listed).matchAll(/^- shell_id=([^\s]+)/gmu)].map(
    (match) => match[1]
  )
  assert.deepEqual(shellIds, ["default", "alpha", "beta"])

  const closed = await connected.client.callTool({
    name: "shell_close",
    arguments: { shell_id: "alpha" },
  })
  assert.equal(closed.structuredContent, undefined)
  assert.equal(toolText(closed), "shell_id=alpha closed=true")
})

test("maps an expired shell cursor to an MCP tool error", { timeout: 10_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "mcp-expired-poll-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const shell = createShellSession({ cwd: workspace, transcriptLimit: 1 })
  const running = await startMcpHttpServer({
    port: 0,
    shellManager: createShellSessionManager({ defaultShell: shell }),
  })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "expired-poll-client")
  t.after(() => connected.client.close())

  const started = snapshotFromResult(
    await connected.client.callTool({
      name: "shell_run",
      arguments: { request_id: "expires", command: "sleep 0.1; printf AB", yield_time_ms: 0 },
    })
  )
  assert.equal(started.status, "running")
  assert.notEqual(started.next_cursor, undefined)

  for (let attempt = 0; attempt < 100 && shell.hasActiveWork; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  const expired = await connected.client.callTool({
    name: "shell_poll",
    arguments: { request_id: "expires", cursor: started.next_cursor, yield_time_ms: 0 },
  })
  assert.equal(expired.isError, true)
  assert.match(JSON.stringify(expired.content), /cursor_expired/u)
})
