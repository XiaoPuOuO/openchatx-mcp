import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import test from "node:test"

import { tempDir } from "../helpers/temp.js"
import { connectClient, startMcpHttpServer, toolText } from "./helpers.js"

test("file_read returns local bytes as an embedded MCP resource", {
  timeout: 10_000,
}, async (t) => {
  const root = await tempDir(t, "shellby-file-read-")
  const path = join(root, "payload.bin")
  const expected = Buffer.from([0, 1, 2, 3, 254, 255])
  await writeFile(path, expected)

  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "file-read-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({ name: "file_read", arguments: { path } })
  assert.equal(result.isError, undefined)
  const resource = result.content.find((item) => item.type === "resource")
  assert.ok(resource && resource.type === "resource" && "blob" in resource.resource)
  assert.deepEqual(Buffer.from(resource.resource.blob, "base64"), expected)
  assert.equal(resource.resource.mimeType, "application/octet-stream")
  assert.match(resource.resource.uri, /payload\.bin$/u)
})

test("file_write downloads a ChatGPT file input to the requested local path", {
  timeout: 10_000,
}, async (t) => {
  const root = await tempDir(t, "shellby-file-write-")
  const path = join(root, "received.bin")
  const expected = Buffer.from([255, 0, 128, 64, 32, 16])
  const source = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" })
    response.end(expected)
  })
  await new Promise<void>((resolve, reject) => {
    source.once("error", reject)
    source.listen(0, "127.0.0.1", () => resolve())
  })
  t.after(() => new Promise<void>((resolve) => source.close(() => resolve())))
  const address = source.address()
  assert.ok(address && typeof address === "object")

  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "file-write-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({
    name: "file_write",
    arguments: {
      file: {
        download_url: `http://127.0.0.1:${address.port}/payload.bin`,
        file_id: "file_test",
        mime_type: "application/octet-stream",
        file_name: "payload.bin",
      },
      path,
    },
  })
  assert.equal(result.isError, undefined)
  assert.deepEqual(await readFile(path), expected)
  assert.match(toolText(result), /Wrote received\.bin \(6 bytes\)/u)
})
