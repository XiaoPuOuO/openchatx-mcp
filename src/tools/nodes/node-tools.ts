import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { NodeRegistry } from "../../nodes/node-registry.js"

export function registerNodeTools(server: McpServer, nodes: NodeRegistry): void {
  server.registerTool(
    "node_manage",
    {
      description:
        "List, register, remove, probe, discover tools on, or call tools on remote OpenChatX nodes.",
      inputSchema: z.object({
        action: z.enum(["list", "upsert", "remove", "probe", "tool_search", "tool_call"]),
        id: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        url: z.url().optional(),
        enabled: z.boolean().optional(),
        token: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        node: z.string().min(1).optional(),
        query: z.string().min(1).optional(),
        tool: z.string().min(1).optional(),
        arguments_json: z.string().default("{}"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        switch (input.action) {
          case "list":
            return { structuredContent: { nodes: await nodes.list() }, content: [] }
          case "upsert": {
            const id = required(input.id, "id", input.action)
            const name = required(input.name, "name", input.action)
            const url = required(input.url, "url", input.action)
            return {
              structuredContent: {
                node: await nodes.upsert({
                  id,
                  name,
                  url,
                  ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
                  ...(input.token ? { token: input.token } : {}),
                  ...(input.description ? { description: input.description } : {}),
                }),
              },
              content: [],
            }
          }
          case "remove": {
            const id = required(input.id, "id", input.action)
            await nodes.remove(id)
            return { structuredContent: { removed: id }, content: [] }
          }
          case "probe":
            return {
              structuredContent: await nodes.probe(required(input.node, "node", input.action)),
              content: [],
            }
          case "tool_search":
            return {
              structuredContent: {
                tools: await nodes.tools(required(input.node, "node", input.action), input.query),
              },
              content: [],
            }
          case "tool_call":
            return {
              structuredContent: {
                result: await nodes.call(
                  required(input.node, "node", input.action),
                  required(input.tool, "tool", input.action),
                  parseArguments(input.arguments_json)
                ),
              },
              content: [],
            }
        }
      } catch (error) {
        throw toToolError(error, "NODE_MANAGE_FAILED")
      }
    }
  )
}

function required<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined) throw new Error(`${field} is required for action=${action}.`)
  return value
}

function parseArguments(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("arguments_json must decode to a JSON object.")
  }
  return Object.fromEntries(Object.entries(parsed))
}
