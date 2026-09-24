import type { McpServer, ServerContext } from "@modelcontextprotocol/server"
import { z } from "zod"

import type { ExternalMcpRegistry } from "../../external-mcp/registry.js"
import { ToolError } from "../../mcp/tool-error.js"
import type { ToolboxRegistry } from "../../toolbox/registry.js"

interface CatalogEntry {
  id: string
  source: "toolbox" | "mcp"
  server?: string
  name: string
  description?: string
  inputSchema: unknown
}

const WHITESPACE_RE = /\s+/u

export function registerCatalogTools(
  server: McpServer,
  toolboxes: ToolboxRegistry,
  externalMcp: ExternalMcpRegistry
): void {
  const searchInput = z.object({
    query: z.string().min(1),
    source: z.enum(["all", "toolbox", "mcp"]).default("all"),
    server: z
      .string()
      .min(1)
      .optional()
      .describe("Optional external MCP server id to restrict the search to, such as blender."),
    limit: z.int().min(1).max(20).default(8),
  })
  const callInput = z.object({
    tool: z.string().min(1).describe("Tool id returned by tool_search."),
    arguments_json: z
      .string()
      .default("{}")
      .describe("JSON object containing the arguments for the discovered tool."),
  })

  const searchCallback = async (input: z.infer<typeof searchInput>) => {
    const results = searchCatalog(
      catalog(toolboxes, externalMcp),
      input.query,
      input.source,
      input.server
    )
      .slice(0, input.limit)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        source: entry.source,
        ...(entry.server ? { server: entry.server } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        input_schema: entry.inputSchema,
      }))
    return {
      content: [
        {
          type: "text" as const,
          text:
            results.length === 0 ? "No matching lazy tools." : JSON.stringify({ tools: results }),
        },
      ],
    }
  }

  const callCallback = async (input: z.infer<typeof callInput>, context: ServerContext) => {
    const argumentsValue = parseToolArguments(input.arguments_json)
    if (input.tool.startsWith("toolbox:")) {
      return toolboxes.callCustomTool(input.tool, argumentsValue, context)
    }
    if (input.tool.startsWith("mcp:")) return externalMcp.call(input.tool, argumentsValue)
    throw new ToolError("UNKNOWN_TOOL", `Unknown lazy tool id ${JSON.stringify(input.tool)}.`)
  }

  Reflect.apply(server.registerTool, server, [
    "tool_search",
    {
      description: "Find custom toolbox or external MCP tools not loaded in the main tool list.",
      inputSchema: searchInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    searchCallback,
  ])

  Reflect.apply(server.registerTool, server, [
    "tool_call",
    {
      description: "Call a lazy tool by id after discovering it with tool_search.",
      inputSchema: callInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    callCallback,
  ])
}

function parseToolArguments(value: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: ToolError stores the original error as its cause.
    throw new ToolError("INVALID_ARGUMENT", "arguments_json must be valid JSON.", error)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ToolError("INVALID_ARGUMENT", "arguments_json must decode to a JSON object.")
  }
  return Object.fromEntries(Object.entries(parsed))
}

function catalog(toolboxes: ToolboxRegistry, externalMcp: ExternalMcpRegistry): CatalogEntry[] {
  return [
    ...toolboxes.customToolCatalog().map((tool) => ({
      id: tool.id,
      source: "toolbox" as const,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    ...externalMcp.catalog().map((tool) => ({
      id: tool.id,
      source: "mcp" as const,
      server: tool.server,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  ]
}

function searchCatalog(
  entries: CatalogEntry[],
  query: string,
  source: "all" | "toolbox" | "mcp",
  server?: string
): CatalogEntry[] {
  const terms = query.toLowerCase().split(WHITESPACE_RE).filter(Boolean)
  return entries
    .filter(
      (entry) =>
        (source === "all" || entry.source === source) &&
        (server === undefined || entry.server === server)
    )
    .map((entry) => ({ entry, score: matchScore(entry, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .map(({ entry }) => entry)
}

function matchScore(entry: CatalogEntry, terms: string[]) {
  const id = entry.id.toLowerCase()
  const name = entry.name.toLowerCase()
  const description = entry.description?.toLowerCase() ?? ""
  let score = 0
  for (const term of terms) {
    if (name === term) score += 20
    else if (name.includes(term)) score += 10
    if (id.includes(term)) score += 5
    if (description.includes(term)) score += 2
  }
  return score
}
