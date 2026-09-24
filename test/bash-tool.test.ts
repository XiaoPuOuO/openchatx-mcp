import assert from "node:assert/strict"
import { access, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import { BashProcessManager } from "../src/tools/shell/bash-process-manager.js"
import { registerBashProcessTool } from "../src/tools/shell/bash-process-tool.js"
import { registerBashTool } from "../src/tools/shell/bash-tool.js"
import { tempDir } from "./helpers/temp.js"

async function connectedBash(t: test.TestContext) {
  const state = await tempDir(t, "openchatx-bash-manager-")
  const manager = new BashProcessManager(join(state, "logs"))
  const server = new McpServer({ name: "bash-test", version: "1.0.0" })
  const client = new Client({ name: "bash-client", version: "1.0.0" })
  registerBashTool(server, manager)
  registerBashProcessTool(server, manager)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([client.close(), server.close()]))
  return client
}

test("bash runs in a fresh process with an explicit workdir", async (t) => {
  const cwd = await tempDir(t, "openchatx-bash-")
  await mkdir(join(cwd, "sub"))
  await writeFile(join(cwd, "sub", "marker.txt"), "ok")
  const client = await connectedBash(t)

  const result = await client.callTool({
    name: "bash",
    arguments: { command: "pwd; cat marker.txt", workdir: join(cwd, "sub") },
  })
  assert.equal(result.isError, undefined)
  const output = (result.structuredContent as { output: string }).output
  assert.match(output, new RegExp(join(cwd, "sub").replaceAll("/", "\\/"), "u"))
  assert.match(output, /ok/u)
})

test("bash keep=true is listed, readable, and stoppable", async (t) => {
  const cwd = await tempDir(t, "openchatx-bash-keep-")
  const marker = join(cwd, "ready.txt")
  const client = await connectedBash(t)

  const startedAt = Date.now()
  const result = await client.callTool({
    name: "bash",
    arguments: {
      command: `printf 'server ready\\n'; printf ready > "${marker}"; sleep 30`,
      workdir: cwd,
      keep: true,
    },
  })
  assert.equal(result.isError, undefined)
  assert.ok(Date.now() - startedAt < 5_000)

  const output = result.structuredContent as {
    kept: boolean
    process_id: string
    pid: number
    cwd: string
  }
  assert.equal(output.kept, true)
  assert.equal(output.cwd, cwd)
  assert.ok(output.pid > 0)
  assert.match(output.process_id, /^bash-\d+$/u)

  let markerReady = false
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await access(marker)
      markerReady = true
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  assert.equal(markerReady, true)

  const listed = await client.callTool({
    name: "bash_process",
    arguments: { action: "list" },
  })
  assert.match(
    listed.content.find((item) => item.type === "text")?.text ?? "",
    new RegExp(`${output.process_id}.*running=true`, "u")
  )

  const read = await client.callTool({
    name: "bash_process",
    arguments: { action: "read", process_id: output.process_id },
  })
  assert.match(read.content.find((item) => item.type === "text")?.text ?? "", /server ready/u)

  const stopped = await client.callTool({
    name: "bash_process",
    arguments: { action: "stop", process_id: output.process_id },
  })
  assert.match(
    stopped.content.find((item) => item.type === "text")?.text ?? "",
    new RegExp(`${output.process_id}.*running=false`, "u")
  )
})

test("bash does not persist cwd or environment between calls", async (t) => {
  const cwd = await tempDir(t, "openchatx-bash-state-")
  const client = await connectedBash(t)

  await client.callTool({
    name: "bash",
    arguments: { command: "cd /; export OPENCHATX_TEMP=present" },
  })
  const result = await client.callTool({
    name: "bash",
    arguments: { command: "pwd; printf '%s' \"${OPENCHATX_TEMP:-missing}\"", workdir: cwd },
  })
  const output = (result.structuredContent as { output: string }).output
  assert.match(output, new RegExp(cwd.replaceAll("/", "\\/"), "u"))
  assert.match(output, /missing/u)
})
