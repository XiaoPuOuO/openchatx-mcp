import type {
  CallToolResult,
  Icon,
  McpServer,
  ServerContext,
  ToolAnnotations,
} from "@modelcontextprotocol/server"
import { z } from "zod"

export type ToolResult = CallToolResult

export interface ToolContext {
  readonly name: string
  readonly toolboxId?: string
  readonly signal: AbortSignal
  readonly mcp: ServerContext
}

export interface ToolLifecycleContext {
  readonly toolboxId: string
}

/**
 * Common contract for every first-party and user-authored tool.
 *
 * Required:
 * - name
 * - description
 * - inputSchema
 * - execute()
 *
 * Optional MCP capabilities are exposed as overridable readonly properties.
 */
export abstract class Tool<TInputSchema extends z.ZodObject = z.ZodObject> {
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly inputSchema: TInputSchema

  readonly title?: string
  readonly outputSchema?: z.ZodType
  readonly annotations?: ToolAnnotations
  readonly icons?: Icon[]
  readonly meta?: Record<string, unknown>
  readonly enabled: boolean = true
  readonly required: boolean = false

  /** Called once when a toolbox is loaded. */
  onLoad?(_context: ToolLifecycleContext): void | Promise<void>

  /** Called once before a toolbox is unloaded or reloaded. */
  onUnload?(_context: ToolLifecycleContext): void | Promise<void>

  abstract execute(
    input: z.infer<TInputSchema>,
    context: ToolContext
  ): ToolResult | Promise<ToolResult>

  register(server: McpServer): void {
    if (!this.enabled) return
    const config = {
      title: this.title,
      description: this.description,
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      annotations: this.annotations,
      icons: this.icons,
      _meta: this.meta,
    }
    const callback = async (input: unknown, context: ServerContext) => {
      const parsed = this.inputSchema.parse(input)
      return this.execute(parsed, {
        name: this.name,
        signal: context.mcpReq.signal,
        mcp: context,
      })
    }
    Reflect.apply(server.registerTool, server, [this.name, config, callback])
  }
}

/** Convenience helper for user-authored tools that prefer object syntax over subclassing. */
export function defineTool<TInputSchema extends z.ZodObject>(
  definition: ToolDefinition<TInputSchema>
): Tool<TInputSchema> {
  return new DefinedTool(definition)
}

export interface ToolDefinition<TInputSchema extends z.ZodObject> {
  name: string
  description: string
  inputSchema: TInputSchema
  title?: string
  outputSchema?: z.ZodType
  annotations?: ToolAnnotations
  icons?: Icon[]
  meta?: Record<string, unknown>
  enabled?: boolean
  required?: boolean
  execute: (input: z.infer<TInputSchema>, context: ToolContext) => ToolResult | Promise<ToolResult>
  onLoad?: (context: ToolLifecycleContext) => void | Promise<void>
  onUnload?: (context: ToolLifecycleContext) => void | Promise<void>
}

class DefinedTool<TInputSchema extends z.ZodObject> extends Tool<TInputSchema> {
  readonly name: string
  readonly description: string
  readonly inputSchema: TInputSchema
  readonly title?: string
  readonly outputSchema?: z.ZodType
  readonly annotations?: ToolAnnotations
  readonly icons?: Icon[]
  readonly meta?: Record<string, unknown>
  readonly enabled: boolean
  readonly required: boolean

  constructor(private readonly definition: ToolDefinition<TInputSchema>) {
    super()
    this.name = definition.name
    this.description = definition.description
    this.inputSchema = definition.inputSchema
    this.title = definition.title
    this.outputSchema = definition.outputSchema
    this.annotations = definition.annotations
    this.icons = definition.icons
    this.meta = definition.meta
    this.enabled = definition.enabled ?? true
    this.required = definition.required ?? false
  }

  override onLoad(context: ToolLifecycleContext): void | Promise<void> {
    return this.definition.onLoad?.(context)
  }

  override onUnload(context: ToolLifecycleContext): void | Promise<void> {
    return this.definition.onUnload?.(context)
  }

  execute(input: z.infer<TInputSchema>, context: ToolContext): ToolResult | Promise<ToolResult> {
    return this.definition.execute(input, context)
  }
}

export { z }
