import assert from "node:assert/strict"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import {
  InteractiveShellManager,
  registerTerminalTool,
} from "../src/tools/shell/interactive-shell.js"
import { tempDir } from "./helpers/temp.js"

async function connectedInteractiveShell(t: test.TestContext, cwd: string) {
  const manager = new InteractiveShellManager(cwd, "/bin/zsh")
  const server = new McpServer({ name: "interactive-shell-test", version: "1.0.0" })
  const client = new Client({ name: "interactive-shell-client", version: "1.0.0" })
  registerTerminalTool(server, manager)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([manager.close(), client.close(), server.close()]))
  return client
}

test("interactive shell provides a real TTY and accepts follow-up input", async (t) => {
  const cwd = await tempDir(t, "openchatx-interactive-")
  const client = await connectedInteractiveShell(t, cwd)

  const started = await client.callTool({
    name: "terminal",
    arguments: {
      action: "create",
      session_id: "prompt-test",
      command: "test -t 0 && test -t 1 && printf 'Name: '; read name; echo HELLO:$name",
      wait_ms: 300,
    },
  })
  assert.equal(started.isError, undefined)
  const startData = started.structuredContent as { output: string; next_cursor: number }
  assert.match(startData.output, /Name:/u)

  const written = await client.callTool({
    name: "terminal",
    arguments: {
      action: "write",
      session_id: "prompt-test",
      input: "Alice",
      enter: true,
      cursor: startData.next_cursor,
      wait_ms: 500,
    },
  })
  assert.equal(written.isError, undefined)
  const writeData = written.structuredContent as { output: string; next_cursor: number }
  const polled = await client.callTool({
    name: "terminal",
    arguments: {
      action: "read",
      session_id: "prompt-test",
      cursor: writeData.next_cursor,
      wait_ms: 500,
    },
  })
  const combined = `${writeData.output}${(polled.structuredContent as { output: string }).output}`
  assert.match(combined, /HELLO:Alice/u)
})

test("interactive shell sessions can be closed", async (t) => {
  const cwd = await tempDir(t, "openchatx-interactive-list-")
  const client = await connectedInteractiveShell(t, cwd)
  await client.callTool({
    name: "terminal",
    arguments: { action: "create", session_id: "list-test", wait_ms: 50 },
  })
  assert.equal(
    (await client.listTools()).tools.some((tool) => tool.name === "terminal"),
    true
  )

  const closed = await client.callTool({
    name: "terminal",
    arguments: { action: "close", session_id: "list-test" },
  })
  assert.equal(closed.isError, undefined)
})
