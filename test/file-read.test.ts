import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import { registerFileReadTool } from "../src/tools/file/file-tools.js"
import { tempDir } from "./helpers/temp.js"

async function connectedFileRead(t: test.TestContext) {
  const server = new McpServer({ name: "file-read-test", version: "1.0.0" })
  const client = new Client({ name: "file-read-client", version: "1.0.0" })
  registerFileReadTool(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([client.close(), server.close()]))
  return client
}

test("file_read returns line-numbered text with offset and limit", async (t) => {
  const root = await tempDir(t, "openchatx-file-read-")
  const path = join(root, "example.txt")
  await writeFile(path, "one\ntwo\nthree\nfour\n")
  const client = await connectedFileRead(t)

  const result = await client.callTool({
    name: "file_read",
    arguments: { filePath: path, offset: 2, limit: 2 },
  })
  assert.equal(result.isError, undefined)
  const text = result.content.find((item) => item.type === "text")?.text ?? ""
  assert.match(text, /2: two/u)
  assert.match(text, /3: three/u)
  assert.match(text, /offset=4/u)
  const metadata = result.structuredContent as {
    line_start: number
    line_end: number
    truncated: boolean
  }
  assert.equal(metadata.line_start, 2)
  assert.equal(metadata.line_end, 3)
  assert.equal(metadata.truncated, true)
})

test("file_read lists directories alphabetically and marks child directories", async (t) => {
  const root = await tempDir(t, "openchatx-file-read-dir-")
  await writeFile(join(root, "z.txt"), "z")
  await writeFile(join(root, "a.txt"), "a")
  await mkdir(join(root, "folder"))
  const client = await connectedFileRead(t)

  const result = await client.callTool({
    name: "file_read",
    arguments: { filePath: root },
  })
  assert.equal(result.isError, undefined)
  const text = result.content.find((item) => item.type === "text")?.text ?? ""
  assert.ok(text.indexOf("a.txt") < text.indexOf("folder/"))
  assert.ok(text.indexOf("folder/") < text.indexOf("z.txt"))
})

test("file_read rejects binary files", async (t) => {
  const root = await tempDir(t, "openchatx-file-read-bin-")
  const path = join(root, "payload.bin")
  await writeFile(path, Buffer.from([0, 1, 2, 3]))
  const client = await connectedFileRead(t)

  const result = await client.callTool({
    name: "file_read",
    arguments: { filePath: path },
  })
  assert.equal(result.isError, true)
  assert.match(result.content.find((item) => item.type === "text")?.text ?? "", /binary file/u)
})
