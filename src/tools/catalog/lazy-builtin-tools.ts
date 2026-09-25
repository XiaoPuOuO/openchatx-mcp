import type { McpServer, ServerContext } from "@modelcontextprotocol/server"
import { z } from "zod"

import { ToolError } from "../../mcp/tool-error.js"

interface LazyBuiltinEntry {
  id: string
  name: string
  description?: string
  inputSchema: unknown
  parse: (input: unknown) => unknown
  call: (input: unknown, context: ServerContext) => unknown | Promise<unknown>
}

interface RegisterConfig {
  description?: string
  inputSchema: z.ZodType
}

type RegisterCallback = (input: unknown, context: ServerContext) => unknown | Promise<unknown>

export class LazyBuiltinTools {
  private readonly entries = new Map<string, LazyBuiltinEntry>()
  private readonly shim: McpServer

  constructor() {
    const registerTool = (
      name: string,
      config: RegisterConfig,
      callback: RegisterCallback
    ): unknown => {
      if (this.entries.has(name)) {
        throw new Error(`Duplicate lazy built-in tool ${JSON.stringify(name)}.`)
      }
      this.entries.set(name, {
        id: `builtin:${name}`,
        name,
        description: config.description,
        inputSchema: z.toJSONSchema(config.inputSchema),
        parse: (input) => config.inputSchema.parse(input),
        call: callback,
      })
      return undefined
    }
    // biome-ignore lint/nursery/noUnsafeTypeAssertion: this minimal shim intentionally exposes only registerTool.
    this.shim = { registerTool } as unknown as McpServer
  }

  server(): McpServer {
    return this.shim
  }

  catalog(): Array<{
    id: string
    source: "builtin"
    name: string
    description?: string
    inputSchema: unknown
  }> {
    return [...this.entries.values()]
      .map((entry) => ({
        id: entry.id,
        source: "builtin" as const,
        name: entry.name,
        ...(entry.description ? { description: entry.description } : {}),
        inputSchema: entry.inputSchema,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async call(id: string, args: Record<string, unknown>, context: ServerContext): Promise<unknown> {
    const name = id.startsWith("builtin:") ? id.slice("builtin:".length) : ""
    const entry = this.entries.get(name)
    if (!entry)
      throw new ToolError("UNKNOWN_TOOL", `Unknown lazy built-in tool ${JSON.stringify(id)}.`)
    return entry.call(entry.parse(args), context)
  }
}
