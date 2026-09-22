import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../config.js"
import type { ReviewPromptTracker } from "../tools/review/review-tool.js"
import { shellRunFileEditNotices } from "../tools/shell/apply-patch-guidance.js"
import { START_HERE_TOOL_NAME } from "../tools/start-here/start-here.js"
import { getAgentIdentity } from "./agent-context.js"
import type { AgentObserver } from "./agent-observer.js"
import type { McpAuditRequest } from "./audit/audit-log.js"
import {
  mergeThenRunResult,
  parseThenRun,
  shouldStopThenRun,
  splitThenRun,
  type ThenRunCall,
  withThenRunSchema,
} from "./then-run.js"
import { appendToolEvents, compactToolResult } from "./tool-output.js"

const SCHEMA_KEY_ORDER = [
  "description",
  "type",
  "$ref",
  "anyOf",
  "oneOf",
  "allOf",
  "default",
  "enum",
  "const",
  "properties",
  "required",
  "items",
  "additionalProperties",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "propertyNames",
  "dependentRequired",
  "dependentSchemas",
  "prefixItems",
  "contains",
  "minContains",
  "maxContains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
  "$defs",
  "definitions",
  "examples",
  "title",
] as const

const SCHEMA_KEY_RANK = new Map<string, number>(SCHEMA_KEY_ORDER.map((key, index) => [key, index]))
const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
])
const SCHEMA_VALUE_KEYS = new Set([
  "additionalProperties",
  "propertyNames",
  "items",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
])
const SCHEMA_ARRAY_KEYS = new Set(["prefixItems", "allOf", "anyOf", "oneOf"])
const MODEL_SCHEMA_STRIP_KEYS = new Set([
  "$schema",
  "examples",
  "title",
  "format",
  "multipleOf",
  "maxLength",
  "minItems",
])
const canonicalizedSchemas = new WeakSet<object>()

interface ToolRegistrationConfig {
  annotations?: unknown
  inputSchema?: unknown
  outputSchema?: unknown
  [key: string]: unknown
}

export interface ToolRegistrationBoundaryOptions {
  drainPendingEvents?: () => string[]
  agentObserver?: AgentObserver
  reviewPromptTracker?: ReviewPromptTracker
  auditRequest?: McpAuditRequest
}

const TOOL_ANNOTATION_DEFAULTS: Record<string, unknown> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

interface StandardSchemaJsonSource {
  jsonSchema: {
    input: (options: unknown) => unknown
    output: (options: unknown) => unknown
  }
}

interface RegisteredTool {
  callback: (...args: unknown[]) => unknown
  inputSchema?: z.ZodType
  outputSchema?: z.ZodType
  acceptsInput: boolean
  nativeContent: boolean
}

export function installToolRegistrationBoundary(
  server: McpServer,
  options: ToolRegistrationBoundaryOptions
): void {
  const originalRegisterTool = server.registerTool
  const registerTool = (name: string, config: ToolRegistrationConfig, callback: unknown): unknown =>
    Reflect.apply(originalRegisterTool, server, [name, config, callback])
  const structuredOutput = MCP_CONFIG.mcp.toolOutput === "structured"
  const tools = new Map<string, RegisteredTool>()

  const dispatchTool = async (
    name: string,
    inputValue: unknown,
    context: unknown,
    nested = false
  ): Promise<unknown> => {
    const tool = tools.get(name)
    if (!tool) return toolError(`Tool ${name} not found.`)

    const auditInput = isRecord(inputValue) ? inputValue : {}
    const auditCall = options.auditRequest?.claimTool(name, auditInput)
    let observedCallId: string | undefined

    try {
      const parsedInput = await parseToolInput(name, tool, inputValue, nested)
      if (parsedInput.error) {
        auditCall?.finish({ toolResult: parsedInput.error, modelResult: parsedInput.error })
        return parsedInput.error
      }

      const input = isRecord(parsedInput.value) ? parsedInput.value : {}
      const { arguments: callbackInput, thenRun } = splitThenRun(name, input)
      const agent = getAgentIdentity()
      if (agent && name !== START_HERE_TOOL_NAME && !agent.taskSlug) {
        const result = startupRequiredResult()
        auditCall?.finish({ toolResult: result, modelResult: result })
        return result
      }

      observedCallId = options.agentObserver?.startTool(agent, name, input)
      const result = await invokeTool(tool, callbackInput, context)
      if (nested) await validateToolOutput(name, tool.outputSchema, result)
      options.agentObserver?.finishTool(agent, observedCallId)

      const projected = projectToolResult(name, result, tool, nested, structuredOutput)
      const events = collectToolEvents(name, input, agent, options)
      const finalResult = appendToolEvents(projected, events)
      auditCall?.finish({ toolResult: result, modelResult: finalResult })
      return continueThenRun(name, result, thenRun, finalResult, context)
    } catch (error) {
      const agent = getAgentIdentity()
      options.agentObserver?.failTool(agent, observedCallId)
      const result = toolError(error instanceof Error ? error.message : String(error))
      auditCall?.finish({ error, modelResult: result })
      return result
    }
  }

  async function continueThenRun(
    name: string,
    result: unknown,
    thenRun: unknown,
    finalResult: unknown,
    context: unknown
  ): Promise<unknown> {
    if (thenRun === undefined || shouldStopThenRun(name, result)) return finalResult

    let next: ThenRunCall
    try {
      next = parseThenRun(thenRun, (toolName) => tools.has(toolName))
    } catch (error) {
      return mergeThenRunResult(
        finalResult,
        toolError(`then_run_error: ${error instanceof Error ? error.message : String(error)}`)
      )
    }
    return mergeThenRunResult(
      finalResult,
      await dispatchTool(next.name, next.arguments, context, true)
    )
  }

  const boundaryRegisterTool = (
    name: string,
    config: ToolRegistrationConfig,
    callback: unknown
  ) => {
    const acceptsInput = config.inputSchema !== undefined
    config.inputSchema = withThenRunSchema(name, config.inputSchema)
    const computerUse = name.startsWith("computer_")
    const nativeContent = computerUse || name === "image_view"
    if (!nativeContent && !structuredOutput) config.outputSchema = undefined
    const inputSchema = config.inputSchema instanceof z.ZodType ? config.inputSchema : undefined
    const outputSchema = config.outputSchema instanceof z.ZodType ? config.outputSchema : undefined
    canonicalizeStandardSchema(config.inputSchema)
    canonicalizeStandardSchema(config.outputSchema)
    const annotations = compactToolAnnotations(config.annotations)
    if (annotations === undefined) config.annotations = undefined
    else config.annotations = annotations

    if (typeof callback !== "function") return registerTool(name, config, callback)
    tools.set(name, {
      callback: (...args: unknown[]) => callback(...args),
      inputSchema,
      outputSchema,
      acceptsInput,
      nativeContent,
    })
    const wrapped = async (...args: unknown[]) => dispatchTool(name, args[0], args[1])
    return registerTool(name, config, wrapped)
  }
  if (!Reflect.set(server, "registerTool", boundaryRegisterTool)) {
    throw new TypeError("Could not install the MCP tool registration boundary.")
  }
}

async function parseToolInput(
  name: string,
  tool: RegisteredTool,
  inputValue: unknown,
  nested: boolean
): Promise<{ value: unknown; error?: ReturnType<typeof toolError> }> {
  const value = inputValue ?? {}
  if (!nested || !tool.inputSchema) return { value }

  const parsed = await tool.inputSchema.safeParseAsync(value)
  if (parsed.success) return { value: parsed.data }
  return {
    value,
    error: toolError(
      `Input validation error: Invalid arguments for tool ${name}: ${parsed.error.issues[0]?.message ?? "validation failed"}`
    ),
  }
}

function invokeTool(
  tool: RegisteredTool,
  callbackInput: Record<string, unknown>,
  context: unknown
): unknown {
  return tool.acceptsInput ? tool.callback(callbackInput, context) : tool.callback(context)
}

function projectToolResult(
  name: string,
  result: unknown,
  tool: RegisteredTool,
  nested: boolean,
  structuredOutput: boolean
): unknown {
  return nested || (!tool.nativeContent && !structuredOutput)
    ? compactToolResult(name, result)
    : result
}

function collectToolEvents(
  name: string,
  input: Record<string, unknown>,
  agent: ReturnType<typeof getAgentIdentity>,
  options: ToolRegistrationBoundaryOptions
): string[] {
  return [
    ...(name === "shell_run" ? shellRunFileEditNotices(input) : []),
    ...(options.drainPendingEvents?.() ?? []),
    ...(options.agentObserver?.drainInstructions(agent) ?? []),
    ...(options.reviewPromptTracker?.() ?? []),
  ]
}

async function validateToolOutput(
  toolName: string,
  schema: z.ZodType | undefined,
  result: unknown
): Promise<void> {
  if (!schema || isToolError(result)) return
  if (!isRecord(result) || result.structuredContent === undefined) {
    throw new Error(
      `Output validation error: Tool ${toolName} has an output schema but no structured content was provided`
    )
  }
  const parsed = await schema.safeParseAsync(result.structuredContent)
  if (!parsed.success)
    throw new Error(
      `Output validation error: Invalid structured content for tool ${toolName}: ${parsed.error.issues[0]?.message ?? "validation failed"}`
    )
}

function toolError(text: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  }
}

function isToolError(value: unknown): boolean {
  return isRecord(value) && value.isError === true
}

function startupRequiredResult() {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: "Shellby has not been initialized for this conversation. Call `start_here` first, and follow the instructions.",
      },
    ],
  }
}

export function compactToolAnnotations(value: unknown): unknown {
  if (!isRecord(value)) return value

  const annotations = Object.fromEntries(
    Object.entries(value).filter(
      ([key, annotation]) => TOOL_ANNOTATION_DEFAULTS[key] !== annotation
    )
  )
  if (annotations.readOnlyHint === true) {
    Reflect.deleteProperty(annotations, "destructiveHint")
    Reflect.deleteProperty(annotations, "idempotentHint")
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined
}

export function canonicalizeJsonSchema(value: unknown): unknown {
  if (!isRecord(value)) return value

  const isIntegerSchema = value.type === "integer"
  const isNumericSchema = isIntegerSchema || value.type === "number"
  const keys = Object.keys(value).sort((left, right) => {
    const leftRank = SCHEMA_KEY_RANK.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightRank = SCHEMA_KEY_RANK.get(right) ?? Number.MAX_SAFE_INTEGER
    return leftRank - rightRank
  })
  const result: Record<string, unknown> = {}

  for (const key of keys) {
    const child = value[key]
    if (shouldStripSchemaEntry(key, child, isIntegerSchema, isNumericSchema)) continue
    result[key] = canonicalizeSchemaChild(key, child)
  }

  return result
}

function canonicalizeStandardSchema(schema: unknown): void {
  if (!isRecord(schema) || canonicalizedSchemas.has(schema)) return
  const standard = schema["~standard"]
  if (!isStandardSchemaJsonSource(standard)) return
  const source = standard

  const input = source.jsonSchema.input
  const output = source.jsonSchema.output
  source.jsonSchema = {
    input: (options) => canonicalizeJsonSchema(input(options)),
    output: (options) => canonicalizeJsonSchema(output(options)),
  }
  canonicalizedSchemas.add(schema)
}

function shouldStripSchemaEntry(
  key: string,
  child: unknown,
  isIntegerSchema: boolean,
  isNumericSchema: boolean
): boolean {
  if (MODEL_SCHEMA_STRIP_KEYS.has(key)) return true
  if (key === "minLength" && (child === 0 || child === 1)) return true
  if (isIntegerSchema && key === "minimum" && child === Number.MIN_SAFE_INTEGER) return true
  if (isNumericSchema && key === "minimum" && (child === 0 || child === 1)) return true
  return isIntegerSchema && key === "maximum" && child === Number.MAX_SAFE_INTEGER
}

function canonicalizeSchemaChild(key: string, child: unknown): unknown {
  if (SCHEMA_MAP_KEYS.has(key) && isRecord(child)) {
    return Object.fromEntries(
      Object.entries(child).map(([name, schema]) => [name, canonicalizeJsonSchema(schema)])
    )
  }
  if (SCHEMA_VALUE_KEYS.has(key)) return canonicalizeJsonSchema(child)
  if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
    return child.map((schema) => canonicalizeJsonSchema(schema))
  }
  return child
}

function isStandardSchemaJsonSource(value: unknown): value is StandardSchemaJsonSource {
  if (!isRecord(value) || !isRecord(value.jsonSchema)) return false
  return (
    typeof value.jsonSchema.input === "function" && typeof value.jsonSchema.output === "function"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
