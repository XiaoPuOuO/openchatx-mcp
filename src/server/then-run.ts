import { z } from "zod"

import { START_HERE_TOOL_NAME } from "../tools/start-here/start-here.js"

const THEN_RUN_SCHEMA = z
  .unknown()
  .optional()
  .describe("Next sequential tool call. May nest additional calls.")

export interface ThenRunCall {
  name: string
  arguments: Record<string, unknown>
}

export function withThenRunSchema(toolName: string, inputSchema: unknown): unknown {
  if (toolName === START_HERE_TOOL_NAME) return inputSchema
  if (inputSchema === undefined) return z.object({ then_run: THEN_RUN_SCHEMA })
  if (inputSchema instanceof z.ZodObject)
    return inputSchema.safeExtend({ then_run: THEN_RUN_SCHEMA })
  throw new Error("Shellby tool input schemas must be Zod objects to support then_run.")
}

export function splitThenRun(
  toolName: string,
  input: Record<string, unknown>
): { arguments: Record<string, unknown>; thenRun?: unknown } {
  if (toolName === START_HERE_TOOL_NAME || input.then_run === undefined) return { arguments: input }
  const { then_run, ...argumentsValue } = input
  return { arguments: argumentsValue, thenRun: then_run }
}

export function parseThenRun(value: unknown, hasTool: (name: string) => boolean): ThenRunCall {
  if (!isRecord(value)) throw new Error("then_run must contain exactly one Shellby tool call.")
  const entries = Object.entries(value)
  if (entries.length !== 1) throw new Error("then_run must contain exactly one Shellby tool call.")

  const [name, argumentsValue] = entries[0]!
  if (name === START_HERE_TOOL_NAME || !hasTool(name))
    throw new Error(`Unknown then_run tool: ${name}.`)
  if (!isRecord(argumentsValue))
    throw new Error(`then_run arguments for ${name} must be an object.`)
  return { name, arguments: argumentsValue }
}

export function mergeThenRunResult(result: unknown, nextResult: unknown): unknown {
  if (!isRecord(result) || !isRecord(nextResult)) return result
  return {
    ...result,
    ...(nextResult.isError === true ? { isError: true } : {}),
    content: mergeContent(result.content, nextResult.content),
  }
}

export function shouldStopThenRun(toolName: string, result: unknown): boolean {
  if (!isRecord(result)) return false
  if (result.isError === true) return true
  if (toolName !== "shell_run" || !isRecord(result.structuredContent)) return false
  const exitCode = result.structuredContent.exit_code
  return typeof exitCode === "number" && exitCode !== 0
}

function mergeContent(current: unknown, next: unknown): unknown[] {
  const output = Array.isArray(current) ? [...current] : []
  for (const item of Array.isArray(next) ? next : []) {
    const previous = output.at(-1)
    if (isTextContent(previous) && isTextContent(item)) {
      output[output.length - 1] = {
        ...previous,
        text:
          previous.text && item.text
            ? `${previous.text}\n\n${item.text}`
            : previous.text || item.text,
      }
    } else {
      output.push(item)
    }
  }
  return output
}

function isTextContent(
  value: unknown
): value is { type: "text"; text: string; [key: string]: unknown } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
