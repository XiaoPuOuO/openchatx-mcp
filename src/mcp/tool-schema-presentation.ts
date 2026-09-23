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
const TOOL_ANNOTATION_DEFAULTS: Record<string, unknown> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}
const canonicalizedSchemas = new WeakSet<object>()

export interface ToolRegistrationConfig {
  annotations?: unknown
  inputSchema?: unknown
  outputSchema?: unknown
  [key: string]: unknown
}

export interface PreparedToolRegistration {
  acceptsInput: boolean
  nativeContent: boolean
}

interface StandardSchemaJsonSource {
  jsonSchema: {
    input: (options: unknown) => unknown
    output: (options: unknown) => unknown
  }
}

/**
 * Apply Shellby's model-facing registration rules to one tool config.
 *
 * This owns the public schema projection contract: compact-output schema visibility,
 * native-content exceptions, annotation pruning, and JSON Schema
 * canonicalization. Runtime dispatch should use only the returned execution metadata.
 */
export function prepareToolRegistration(
  name: string,
  config: ToolRegistrationConfig,
  structuredOutput: boolean
): PreparedToolRegistration {
  const acceptsInput = config.inputSchema !== undefined

  const nativeContent =
    name.startsWith("computer_") || name === "image_view" || name === "file_read"
  if (!nativeContent && !structuredOutput) config.outputSchema = undefined

  canonicalizeStandardSchema(config.inputSchema)
  canonicalizeStandardSchema(config.outputSchema)

  config.annotations = compactToolAnnotations(config.annotations)

  return { acceptsInput, nativeContent }
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
