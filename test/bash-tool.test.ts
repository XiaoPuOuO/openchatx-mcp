import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import { registerBashTool } from "../src/tools/shell/bash-tool.js"
import { tempDir } from "./helpers/temp.js"

async function connectedBash(t: test.TestContext) {
  const server = new McpServer({ name: "bash-test", version: "1.0.0" })
  const client = new Client({ name: "bash-client", version: "1.0.0" })
  registerBashTool(server)
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
