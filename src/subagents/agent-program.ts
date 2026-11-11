import { z } from "zod"

const programStepSchema = z.object({
  id: z.string().regex(/^[A-Za-z][\w-]{0,39}$/u),
  tool: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()).default({}),
})
export const agentProgramSchema = z.object({
  steps: z.array(programStepSchema).min(1).max(24),
  stop_on_error: z.boolean().default(true),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export type AgentProgram = z.infer<typeof agentProgramSchema>
export interface AgentProgramResult {
  id: string
  tool: string
  failed: boolean
  text: string
}

function resolveReference(
  value: unknown,
  results: ReadonlyMap<string, unknown>,
  depth = 0
): unknown {
  if (depth > 16) throw new Error("Program arguments exceed the nesting limit.")
  if (Array.isArray(value)) return value.map((part) => resolveReference(part, results, depth + 1))
  if (!isRecord(value)) return value
  const data = value
  if (typeof data.$from === "string") {
    if (!results.has(data.$from)) throw new Error(`Unknown program result: ${data.$from}`)
    let resolved = results.get(data.$from)
    if (typeof data.path === "string") {
      for (const key of data.path.split(".")) {
        if (!isRecord(resolved)) throw new Error(`Cannot read ${data.path} from ${data.$from}.`)
        resolved = resolved[key]
      }
    }
    return resolved
  }
  return Object.fromEntries(
    Object.entries(data).map(([key, part]) => [key, resolveReference(part, results, depth + 1)])
  )
}

function referenceIds(value: unknown, ids: Set<string>, depth = 0): void {
  if (depth > 16) throw new Error("Program arguments exceed the nesting limit.")
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) referenceIds(item, ids, depth + 1)
    return
  }
  if (!isRecord(value)) return
  const data = value
  if (typeof data.$from === "string") {
    ids.add(data.$from)
    return
  }
  for (const item of Object.values(data)) referenceIds(item, ids, depth + 1)
}

function parseResult(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return text
  }
}

type ProgramStep = AgentProgram["steps"][number]
interface ProgramOptions {
  known: ReadonlySet<string>
  readOnly: ReadonlySet<string>
  call: (tool: string, args: Record<string, unknown>) => Promise<{ text: string; failed: boolean }>
  onProgress?: (message: string) => void
  signal?: AbortSignal
}

function validateProgram(steps: ProgramStep[], known: ReadonlySet<string>): void {
  const seen = new Set<string>()
  for (const step of steps) {
    if (seen.has(step.id)) throw new Error(`Duplicate program step: ${step.id}`)
    if (step.tool === "agent_program" || !known.has(step.tool))
      throw new Error(`Unknown or forbidden program tool: ${step.tool}`)
    seen.add(step.id)
  }
}

function nextProgramBatch(
  steps: ProgramStep[],
  start: number,
  values: ReadonlyMap<string, unknown>,
  readOnly: ReadonlySet<string>
): ProgramStep[] {
  const batch: ProgramStep[] = []
  for (let offset = start; offset < steps.length && batch.length < 8; offset += 1) {
    const step = steps[offset]
    if (!step) break
    if (batch.length > 0 && !readOnly.has(step.tool)) break
    if (batch.length > 0 && !readOnly.has(batch[0]?.tool ?? "")) break
    const dependencies = new Set<string>()
    referenceIds(step.arguments, dependencies)
    if ([...dependencies].some((id) => !values.has(id))) {
      if (batch.length > 0) break
      throw new Error(`Program step ${step.id} references an incomplete step.`)
    }
    batch.push(step)
    if (!readOnly.has(step.tool)) break
  }
  return batch
}

async function runProgramStep(
  step: ProgramStep,
  values: ReadonlyMap<string, unknown>,
  options: ProgramOptions
): Promise<AgentProgramResult> {
  options.onProgress?.(`Running ${step.id}: ${step.tool}`)
  const args = resolveReference(step.arguments, values)
  if (!isRecord(args)) throw new Error(`Invalid arguments for program step ${step.id}.`)
  const result = await options.call(step.tool, args)
  options.onProgress?.(`Finished ${step.id}: ${step.tool}`)
  return { id: step.id, tool: step.tool, failed: result.failed, text: result.text.slice(0, 16_000) }
}

/**
 * A deterministic dataflow-style Code Mode: no eval or arbitrary JS.
 * Every operation passes through the existing MCP authorization boundary.
 */
export async function executeAgentProgram(
  raw: unknown,
  options: ProgramOptions
): Promise<AgentProgramResult[]> {
  const program = agentProgramSchema.parse(raw)
  validateProgram(program.steps, options.known)
  const values = new Map<string, unknown>()
  const completed: AgentProgramResult[] = []
  let index = 0
  while (index < program.steps.length) {
    if (options.signal?.aborted) throw options.signal.reason
    const batch = nextProgramBatch(program.steps, index, values, options.readOnly)
    const outputs = await Promise.all(batch.map((step) => runProgramStep(step, values, options)))
    for (const item of outputs) {
      values.set(item.id, parseResult(item.text))
      completed.push(item)
    }
    if (program.stop_on_error && outputs.some((item) => item.failed)) break
    index += batch.length
  }
  return completed
}
