import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { tempDir } from "../helpers/temp.js"
import { connectClient, startMcpHttpServer, toolText } from "./helpers.js"

test("file_read rejects ordinary binary files", {
  timeout: 10_000,
}, async (t) => {
  const root = await tempDir(t, "openchatx-file-read-")
  const path = join(root, "payload.bin")
  await writeFile(path, Buffer.from([0, 1, 2, 3, 254, 255]))

  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "file-read-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({
    name: "file_read",
    arguments: { filePath: path },
  })
  assert.equal(result.isError, true)
  assert.match(toolText(result), /Cannot read binary file/u)
})

test("file_write creates and overwrites text while returning a diff", {
  timeout: 10_000,
}, async (t) => {
  const root = await tempDir(t, "openchatx-file-write-")
  const path = join(root, "nested", "example.txt")

  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "file-write-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({
    name: "file_write",
    arguments: { filePath: path, content: "first\n" },
  })
  assert.equal(result.isError, undefined)
  assert.equal(await readFile(path, "utf8"), "first\n")
  assert.match(toolText(result), /\+first/u)
  assert.match(toolText(result), /created=true/u)

  const overwritten = await connected.client.callTool({
    name: "file_write",
    arguments: { filePath: path, content: "second\n" },
  })
  assert.equal(overwritten.isError, undefined)
  assert.equal(await readFile(path, "utf8"), "second\n")
  assert.match(toolText(overwritten), /-first/u)
  assert.match(toolText(overwritten), /\+second/u)
  assert.match(toolText(overwritten), /created=false/u)
})
