import { readFile } from "node:fs/promises"
import { basename, isAbsolute, resolve } from "node:path"

import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { encodeImageForMcp, formatBytes, ImageEncodingError } from "./image-encoding.js"

export function registerImageTools(server: McpServer, workspace: string): void {
  server.registerTool(
    "image_view",
    {
      description: "View a local image file.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Local image path. Relative paths resolve from the workspace."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }, ctx) => {
      const imagePath = isAbsolute(path) ? path : resolve(workspace, path)
      try {
        const encoded = await encodeImageForMcp(await readFile(imagePath, { signal: ctx.mcpReq.signal }))
        return {
          content: [
            {
              type: "text" as const,
              text: `${basename(imagePath)} — ${encoded.width}×${encoded.height} — ${formatBytes(encoded.sizeBytes)}`,
            },
            {
              type: "image" as const,
              data: encoded.data,
              mimeType: encoded.mimeType,
            },
          ],
        }
      } catch (error) {
        const text =
          error instanceof ImageEncodingError
            ? `${error.code}: ${error.message}`
            : `IMAGE_VIEW_FAILED: ${error instanceof Error ? error.message : String(error)}`
        return {
          isError: true,
          content: [{ type: "text" as const, text }],
        }
      }
    }
  )
}
