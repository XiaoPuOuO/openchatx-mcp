import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import sharp from "sharp"

import { connectClient, startMcpHttpServer } from "./helpers.js"

test("returns image_view as native MCP image content", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "image-view-integration-"))
  const imagePath = join(root, "sample.png")
  await sharp({
    create: {
      width: 12,
      height: 8,
      channels: 3,
      background: { r: 120, g: 80, b: 40 },
    },
  })
    .png()
    .toFile(imagePath)

  const running = await startMcpHttpServer()
  t.after(async () => {
    await running.close()
    await rm(root, { recursive: true, force: true })
  })
  const connected = await connectClient(running.url, "image-view-integration-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({
    name: "image_view",
    arguments: { path: imagePath },
  })
  assert.equal(result.isError, undefined)
  assert.equal(result.structuredContent, undefined)
  assert.deepEqual(
    result.content.map((block) => block.type),
    ["text", "image"]
  )
  assert.equal(result.content[1]?.type, "image")
  assert.equal(
    result.content[1]?.type === "image" ? result.content[1].mimeType : undefined,
    "image/jpeg"
  )
  assert.ok(result.content[1]?.type === "image" && result.content[1].data.length > 0)
})
