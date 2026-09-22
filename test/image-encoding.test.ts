import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import test from "node:test"

import sharp from "sharp"

import { encodeImageForMcp, ImageEncodingError } from "../src/tools/image/image-encoding.js"

test("encodes images for MCP without resizing", async () => {
  const input = await sharp({
    create: {
      width: 64,
      height: 32,
      channels: 3,
      background: { r: 20, g: 40, b: 60 },
    },
  })
    .png()
    .toBuffer()

  const result = await encodeImageForMcp(input)
  const encoded = Buffer.from(result.data, "base64")

  assert.equal(result.mimeType, "image/jpeg")
  assert.equal(result.width, 64)
  assert.equal(result.height, 32)
  assert.equal(result.sizeBytes, encoded.length)
  assert.equal(encoded.subarray(0, 3).toString("hex"), "ffd8ff")
})

test("does not apply orientation transforms that would change computer-use geometry", async () => {
  const input = await sharp({
    create: {
      width: 10,
      height: 20,
      channels: 3,
      background: { r: 20, g: 40, b: 60 },
    },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer()

  const result = await encodeImageForMcp(input)

  assert.equal(result.width, 10)
  assert.equal(result.height, 20)
})

test("reduces JPEG quality when needed to stay under the response budget", async () => {
  const width = 512
  const height = 512
  const pixels = randomBytes(width * height * 3)
  const input = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer()
  const quality65 = await sharp(input)
    .jpeg({ quality: 65, progressive: true, chromaSubsampling: "4:4:4" })
    .toBuffer()
  const quality55 = await sharp(input)
    .jpeg({ quality: 55, progressive: true, chromaSubsampling: "4:4:4" })
    .toBuffer()
  assert.ok(quality55.length < quality65.length)

  const headroomBytes = 64 * 1024
  const maxBase64Bytes = Math.floor(
    (base64Size(quality65.length) + base64Size(quality55.length)) / 2
  )
  const result = await encodeImageForMcp(input, {
    maxResponseBytes: headroomBytes + maxBase64Bytes,
  })

  assert.ok(Buffer.byteLength(result.data, "ascii") <= maxBase64Bytes)
  assert.equal(result.width, width)
  assert.equal(result.height, height)
})

test("fails instead of resizing when an image cannot fit", async () => {
  const width = 512
  const height = 512
  const pixels = randomBytes(width * height * 3)
  const input = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer()

  await assert.rejects(
    encodeImageForMcp(input, { maxResponseBytes: 66 * 1024 }),
    (error: unknown) =>
      error instanceof ImageEncodingError &&
      error.code === "IMAGE_TOO_LARGE" &&
      /without resizing/u.test(error.message)
  )
})

function base64Size(bytes: number): number {
  return 4 * Math.ceil(bytes / 3)
}
