import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import type { ToolOutputStructuredMode } from "../config.js"
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
}

const TOOL_ANNOTATION_DEFAULTS: Record<string, unknown> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

const SHELL_FILE_EDIT_NOTICE = "NOTICE: Use the `apply_patch` MCP tool over `shell_run` for file changes."
const OBVIOUS_SHELL_FILE_EDIT_PATTERNS = [
  /\bcat\b[^\n]*(?:>>?)\s*[^&|>]/,
  /\btee\b(?:\s+-[A-Za-z]+)*\s+[^|;&\n]+/,
  /\bsed\b[^\n]*\s-i(?:\s|['".]|$)/,
  /\.(?:write_text|write_bytes)\s*\(/,
  /\bopen\s*\([^)]*,\s*["'][wax](?:\+)?["']/,
] as const

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
      const structuredRequested = options.toolOutputStructured === "always" || (options.toolOutputStructured === "optional" && input?.structured === true)
      if (input && "structured" in input) {
        const toolInput = { ...input }
        delete toolInput.structured
        args[0] = toolInput
      }

      const result = await callback(...args)
      const projected = !nativeContent && !structuredRequested ? (name === "apply_patch" ? compactApplyPatchResult(result) : compactToolResult(result)) : result
      const events = [...shellRunFileEditNotices(name, input), ...(options.drainPendingEvents?.() ?? [])]
      return appendToolEvents(projected, events)
    }
    return registerTool(name, config, wrapped)
  }) as typeof server.registerTool
}

export function shellRunFileEditNotices(toolName: string, input: Record<string, unknown> | undefined): string[] {
  if (toolName !== "shell_run" || !input) return []
  const commands = [
    ...(typeof input.command === "string" ? [input.command] : []),
    ...(Array.isArray(input.commands) ? input.commands.flatMap((entry) => (isRecord(entry) && typeof entry.command === "string" ? [entry.command] : [])) : []),
  ]
  return commands.some((command) => OBVIOUS_SHELL_FILE_EDIT_PATTERNS.some((pattern) => pattern.test(command))) ? [SHELL_FILE_EDIT_NOTICE] : []
}

function compactApplyPatchResult(result: unknown): unknown {
  if (!isRecord(result) || !isRecord(result.structuredContent)) return compactToolResult(result)

  const structured = result.structuredContent
  const inline: string[] = []
  const sections: string[] = []

  if (typeof structured.status === "string") inline.push(`status=${structured.status}`)
  if (typeof structured.exit_code === "number" || structured.exit_code === null) inline.push(`exit_code=${String(structured.exit_code)}`)
  if (structured.output_dropped === true) inline.push("output_dropped=true")
  if (typeof structured.changed === "string" && structured.changed) sections.push(`changed:\n${structured.changed}`)
  if (typeof structured.failed === "string" && structured.failed) sections.push(`failed:\n${structured.failed}`)
  if (typeof structured.output === "string" && structured.output) sections.push(`output:\n\n${structured.output}`)

  const compact: Record<string, unknown> = { ...result }
  delete compact.structuredContent
  const rendered = [inline.join(" "), ...sections].filter(Boolean).join("\n\n")
  if (!rendered) return compact
  compact.content = [...(Array.isArray(compact.content) ? compact.content : []), { type: "text", text: rendered }]
  return compact
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
