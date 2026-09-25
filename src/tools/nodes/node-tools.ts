import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { NodeRegistry } from "../../nodes/node-registry.js"

export function registerNodeTools(server: McpServer, nodes: NodeRegistry): void {
  server.registerTool(
    "node_list",
    {
      description: "List configured OpenChatX nodes for multi-machine execution.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({ structuredContent: { nodes: await nodes.list() }, content: [] })
  )

  server.registerTool(
    "node_manage",
    {
      description: "Register, update, or remove another OpenChatX node.",
      inputSchema: z.discriminatedUnion("action", [
        z.object({
          action: z.literal("upsert"),
          id: z.string().min(1),
          name: z.string().min(1),
          url: z.url(),
          enabled: z.boolean().optional(),
          token: z.string().min(1).optional(),
          description: z.string().min(1).optional(),
        }),
        z.object({ action: z.literal("remove"), id: z.string().min(1) }),
      ]),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        if (input.action === "remove") {
          await nodes.remove(input.id)
          return { structuredContent: { removed: input.id }, content: [] }
        }
        return { structuredContent: { node: await nodes.upsert(input) }, content: [] }
      } catch (error) {
        throw toToolError(error, "NODE_MANAGE_FAILED")
      }
    }
  )

  server.registerTool(
    "node_probe",
    {
      description: "Probe the health endpoint of a configured OpenChatX node.",
      inputSchema: z.object({ node: z.string().min(1) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ node }) => ({ structuredContent: await nodes.probe(node), content: [] })
  )

  server.registerTool(
    "node_tool_search",
    {
      description: "Discover tools exposed by another configured OpenChatX node.",
      inputSchema: z.object({
        node: z.string().min(1),
        query: z.string().min(1).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ node, query }) => {
      try {
        return { structuredContent: { tools: await nodes.tools(node, query) }, content: [] }
      } catch (error) {
        throw toToolError(error, "NODE_TOOL_SEARCH_FAILED")
      }
    }
  )

  server.registerTool(
    "node_tool_call",
    {
      description: "Call a tool on another configured OpenChatX node after node_tool_search.",
      inputSchema: z.object({
        node: z.string().min(1),
        tool: z.string().min(1),
        arguments_json: z.string().default("{}"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ node, tool, arguments_json }) => {
      try {
        return {
          structuredContent: {
            result: await nodes.call(node, tool, parseArguments(arguments_json)),
          },
          content: [],
        }
      } catch (error) {
        throw toToolError(error, "NODE_TOOL_CALL_FAILED")
      }
    }
  )
}

function parseArguments(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("arguments_json must decode to a JSON object.")
  }
  return Object.fromEntries(Object.entries(parsed))
}
