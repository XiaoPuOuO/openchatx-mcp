import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import type { ToolOutputStructuredMode } from "../config.js"
import { shellRunFileEditNotices } from "../tools/shell/apply-patch-guidance.js"
import { START_HERE_TOOL_NAME } from "../tools/start-here/start-here.js"
import type { McpAuditRequest } from "./audit-log.js"
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
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"])
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
const canonicalizedSchemas = new WeakSet<object>()

interface ToolRegistrationConfig {
  annotations?: unknown
  inputSchema?: unknown
  outputSchema?: unknown
  [key: string]: unknown
}

export interface ToolRegistrationBoundaryOptions {
  toolOutputStructured: ToolOutputStructuredMode
  drainPendingEvents?: () => string[]
  sessionId?: string
  startedSessions?: Set<string>
  auditRequest?: McpAuditRequest
}

const TOOL_ANNOTATION_DEFAULTS: Record<string, unknown> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

interface StandardSchemaJsonSource {
  jsonSchema?: {
    input: (options: unknown) => unknown
    output: (options: unknown) => unknown
  }
}

export function installToolRegistrationBoundary(server: McpServer, options: ToolRegistrationBoundaryOptions): void {
  const registerTool = server.registerTool.bind(server) as unknown as (name: string, config: ToolRegistrationConfig, callback: unknown) => unknown

  server.registerTool = ((name: string, config: ToolRegistrationConfig, callback: unknown) => {
    const computerUse = name.startsWith("computer_")
    const nativeContent = computerUse || name === "image_view"
    if (!nativeContent && options.toolOutputStructured !== "always") {
      delete config.outputSchema
    }
    if (!nativeContent && options.toolOutputStructured === "optional") {
      config.inputSchema = addStructuredInput(config.inputSchema)
    }
    canonicalizeStandardSchema(config.inputSchema)
    canonicalizeStandardSchema(config.outputSchema)
    const annotations = compactToolAnnotations(config.annotations)
    if (annotations === undefined) delete config.annotations
    else config.annotations = annotations

    if (typeof callback !== "function") return registerTool(name, config, callback)
    const wrapped = async (...args: unknown[]) => {
      const input = isRecord(args[0]) ? args[0] : undefined
      const auditCall = options.auditRequest?.claimTool(name, input ?? {})
      const structuredRequested = options.toolOutputStructured === "always" || (options.toolOutputStructured === "optional" && input?.structured === true)
      if (input && "structured" in input) {
        const toolInput = { ...input }
        delete toolInput.structured
        args[0] = toolInput
      }

      try {
        if (options.sessionId && options.startedSessions && name !== START_HERE_TOOL_NAME && !options.startedSessions.has(options.sessionId)) {
          const result = startupRequiredResult()
          auditCall?.finish({ toolResult: result, modelResult: result })
          return result
        }

        const result = await callback(...args)
        if (name === START_HERE_TOOL_NAME && options.sessionId && options.startedSessions && !isToolError(result)) {
          options.startedSessions.add(options.sessionId)
        }
        const projected = !nativeContent && !structuredRequested ? compactToolResult(name, result) : result
        const events = [...(name === "shell_run" ? shellRunFileEditNotices(input) : []), ...(options.drainPendingEvents?.() ?? [])]
        const finalResult = appendToolEvents(projected, events)
        auditCall?.finish({ toolResult: result, modelResult: finalResult })
        return finalResult
      } catch (error) {
        auditCall?.finish({ error })
        throw error
      }
    }
    return registerTool(name, config, wrapped)
  }) as typeof server.registerTool
}

function startupRequiredResult() {
  return {
    isError: true,
    content: [{ type: "text" as const, text: "Shellby has not been initialized for this conversation. Call `start_here` first." }],
  }
}

function isToolError(value: unknown): boolean {
  return isRecord(value) && value.isError === true
}

function addStructuredInput(schema: unknown): unknown {
  const structured = z.boolean().optional().default(false).describe("Return full structured tool schema result")
  if (schema === undefined) return z.object({ structured })
  if (!isRecord(schema) || typeof schema.extend !== "function") return schema
  const extend = schema.extend as (shape: Record<string, unknown>) => unknown
  return extend({ structured })
}

export function compactToolAnnotations(value: unknown): unknown {
  if (!isRecord(value)) return value

  const annotations = Object.fromEntries(Object.entries(value).filter(([key, annotation]) => TOOL_ANNOTATION_DEFAULTS[key] !== annotation))
  if (annotations.readOnlyHint === true) {
    delete annotations.destructiveHint
    delete annotations.idempotentHint
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined
}

export function canonicalizeJsonSchema(value: unknown): unknown {
  if (!isRecord(value)) return value

  const isIntegerSchema = value.type === "integer"
  const keys = Object.keys(value).sort((left, right) => {
    const leftRank = SCHEMA_KEY_RANK.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightRank = SCHEMA_KEY_RANK.get(right) ?? Number.MAX_SAFE_INTEGER
    return leftRank - rightRank
  })
  const result: Record<string, unknown> = {}

  for (const key of keys) {
    const child = value[key]
    if (key === "$schema") continue
    if (isIntegerSchema && key === "minimum" && child === Number.MIN_SAFE_INTEGER) continue
    if (isIntegerSchema && key === "maximum" && child === Number.MAX_SAFE_INTEGER) continue

    if (SCHEMA_MAP_KEYS.has(key) && isRecord(child)) {
      result[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, canonicalizeJsonSchema(schema)]))
    } else if (SCHEMA_VALUE_KEYS.has(key)) {
      result[key] = canonicalizeJsonSchema(child)
    } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      result[key] = child.map((schema) => canonicalizeJsonSchema(schema))
    } else {
      result[key] = child
    }
  }

  return result
}

function canonicalizeStandardSchema(schema: unknown): void {
  if (!isRecord(schema) || canonicalizedSchemas.has(schema)) return
  const standard = schema["~standard"]
  if (!isRecord(standard)) return
  const source = standard as StandardSchemaJsonSource
  if (!source.jsonSchema) return

  const input = source.jsonSchema.input
  const output = source.jsonSchema.output
  source.jsonSchema = {
    input: (options) => canonicalizeJsonSchema(input(options)),
    output: (options) => canonicalizeJsonSchema(output(options)),
  }
  canonicalizedSchemas.add(schema)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
