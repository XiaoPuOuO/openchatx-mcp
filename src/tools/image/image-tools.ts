import { readFile } from "node:fs/promises"
import { basename, isAbsolute, resolve } from "node:path"

import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { ToolError, toToolError } from "../../mcp/tool-error.js"
import type { ProjectScope } from "../../projects/project-scope.js"
import { encodeImageForMcp, formatBytes, ImageEncodingError } from "./image-encoding.js"

export function registerImageTools(server: McpServer, projectScope?: ProjectScope): void {
  server.registerTool(
    "image_view",
    {
      description: "View a local image file.",
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe(
            "Local image path. Relative paths resolve from the active Project root, otherwise the user's home directory."
          ),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe("Optional Project id. Read permission is enforced."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, project_id }, ctx) => {
      try {
        let imagePath = isAbsolute(path) ? path : resolve(MCP_CONFIG.defaultCwd, path)
        if (projectScope)
          imagePath = (await projectScope.resolvePath(path, "read", project_id)).path
        const encoded = await encodeImageForMcp(
          await readFile(imagePath, { signal: ctx.mcpReq.signal })
        )
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
        if (error instanceof ImageEncodingError)
          // biome-ignore lint/style/useErrorCause: ToolError stores the original error as its cause.
          throw new ToolError(error.code, error.message, error)
        throw toToolError(error, "IMAGE_VIEW_FAILED")
      }
    }
  )
}
