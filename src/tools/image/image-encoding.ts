import sharp from "sharp"

const MAX_MCP_IMAGE_RESPONSE_BYTES = 4 * 1024 * 1024

const RESPONSE_HEADROOM_BYTES = 64 * 1024
const JPEG_QUALITIES = [85, 65, 55, 45, 35] as const

export interface EncodedMcpImage {
  data: string
  mimeType: "image/jpeg"
  width: number
  height: number
  sizeBytes: number
}

export interface EncodeImageOptions {
  maxResponseBytes?: number
}

export class ImageEncodingError extends Error {
  readonly code: "IMAGE_TOO_LARGE" | "IMAGE_ENCODE_FAILED"

  constructor(code: ImageEncodingError["code"], message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ImageEncodingError"
    this.code = code
  }
}

export async function encodeImageForMcp(
  input: Buffer,
  options: EncodeImageOptions = {}
): Promise<EncodedMcpImage> {
  const maxResponseBytes = options.maxResponseBytes ?? MAX_MCP_IMAGE_RESPONSE_BYTES
  const maxBase64Bytes = maxResponseBytes - RESPONSE_HEADROOM_BYTES
  if (maxBase64Bytes <= 0) {
    throw new ImageEncodingError("IMAGE_TOO_LARGE", "Image response budget is too small.")
  }

  try {
    const source = sharp(input)
    for (const quality of JPEG_QUALITIES) {
      const { data, info } = await source
        .clone()
        .jpeg({
          quality,
          progressive: true,
          chromaSubsampling: "4:4:4",
        })
        .toBuffer({ resolveWithObject: true })

      if (base64Size(data.length) <= maxBase64Bytes) {
        return {
          data: data.toString("base64"),
          mimeType: "image/jpeg",
          width: info.width,
          height: info.height,
          sizeBytes: data.length,
        }
      }
    }
  } catch (error) {
    if (error instanceof ImageEncodingError) throw error
    throw new ImageEncodingError(
      "IMAGE_ENCODE_FAILED",
      error instanceof Error ? error.message : String(error),
      { cause: error }
    )
  }

  throw new ImageEncodingError(
    "IMAGE_TOO_LARGE",
    `Image cannot fit within the ${formatBytes(maxResponseBytes)} response limit without resizing.`
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function base64Size(bytes: number): number {
  return 4 * Math.ceil(bytes / 3)
}
