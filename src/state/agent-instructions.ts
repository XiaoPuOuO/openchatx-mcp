import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const BASELINE_FILE = "AGENTS.default.md"
const MANAGED_STATE_DIR = ".managed"
const SECTION_HEADING_PATTERN = /^##\s+\S/u

export interface AgentInstructionsSyncResult {
  agentsPath: string
  baselinePath: string
  created: boolean
  updated: boolean
}

export async function synchronizeAgentInstructions(
  stateDir: string,
  bundledTemplate: string,
  previousBundledTemplate?: string
): Promise<AgentInstructionsSyncResult> {
  await mkdir(stateDir, { recursive: true })
  const agentsPath = join(stateDir, "AGENTS.md")
  const managedDir = join(stateDir, MANAGED_STATE_DIR)
  const baselinePath = join(managedDir, BASELINE_FILE)
  await mkdir(managedDir, { recursive: true })

  const existing = await readOptional(agentsPath)
  const baseline = await readOptional(baselinePath)

  if (existing === undefined) {
    await writeFile(agentsPath, bundledTemplate, "utf8")
    await writeFile(baselinePath, bundledTemplate, "utf8")
    return { agentsPath, baselinePath, created: true, updated: false }
  }

  const previousDefault = baseline ?? previousBundledTemplate
  const merged =
    previousDefault === undefined
      ? existing
      : mergeAgentInstructions(previousDefault, existing, bundledTemplate)

  if (merged !== existing) await writeFile(agentsPath, merged, "utf8")
  if (baseline !== bundledTemplate) await writeFile(baselinePath, bundledTemplate, "utf8")

  return {
    agentsPath,
    baselinePath,
    created: false,
    updated: merged !== existing,
  }
}

export function mergeAgentInstructions(
  previousDefault: string,
  userInstructions: string,
  nextDefault: string
): string {
  if (userInstructions === previousDefault) return nextDefault
  if (previousDefault === nextDefault) return userInstructions

  const previous = splitSections(previousDefault)
  const user = splitSections(userInstructions)
  const next = splitSections(nextDefault)

  const output: string[] = []
  output.push(mergeText(previous.preamble, user.preamble, next.preamble))

  for (const key of next.order) {
    const nextSection = next.sections.get(key)
    if (nextSection === undefined) continue

    const previousSection = previous.sections.get(key)
    if (previousSection === undefined) {
      output.push(nextSection)
      continue
    }

    const userSection = user.sections.get(key)
    if (userSection === undefined) continue

    output.push(mergeText(previousSection, userSection, nextSection))
  }

  for (const key of user.order) {
    if (previous.sections.has(key) || next.sections.has(key)) continue
    const section = user.sections.get(key)
    if (section !== undefined) output.push(section)
  }

  return joinSections(output)
}

interface SectionedDocument {
  preamble: string
  order: string[]
  sections: Map<string, string>
}

function splitSections(value: string): SectionedDocument {
  const lines = value.replace(/\r\n/gu, "\n").split("\n")
  const sections = new Map<string, string>()
  const order: string[] = []
  const preamble: string[] = []
  let currentKey: string | undefined
  let currentLines: string[] = []

  const flush = () => {
    if (currentKey === undefined) return
    sections.set(currentKey, currentLines.join("\n").trimEnd())
    order.push(currentKey)
  }

  for (const line of lines) {
    if (SECTION_HEADING_PATTERN.test(line)) {
      flush()
      currentKey = line.trim()
      currentLines = [line]
      continue
    }

    if (currentKey === undefined) preamble.push(line)
    else currentLines.push(line)
  }
  flush()

  return {
    preamble: preamble.join("\n").trimEnd(),
    order,
    sections,
  }
}

function joinSections(parts: string[]): string {
  return `${parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()}\n`
}

function mergeText(previousDefault: string, userText: string, nextDefault: string): string {
  if (userText === previousDefault) return nextDefault
  if (nextDefault === previousDefault) return userText

  const previousLines = previousDefault.split("\n")
  const userLines = userText.split("\n")
  const nextLines = nextDefault.split("\n")
  const edits = diffEdits(previousLines, userLines)
  if (edits.length === 0) return nextDefault

  const baseToNext = lcsMatches(previousLines, nextLines)
  const merged = [...nextLines]
  const mapped = edits.map((edit) => ({
    ...edit,
    ...mapEditToNext(edit, baseToNext, nextLines.length),
  }))

  for (const edit of mapped.reverse()) {
    merged.splice(edit.nextStart, edit.nextEnd - edit.nextStart, ...edit.replacement)
  }
  return merged.join("\n")
}

interface LineEdit {
  start: number
  end: number
  replacement: string[]
}

function diffEdits(base: string[], changed: string[]): LineEdit[] {
  const matches = lcsMatches(base, changed)
  const edits: LineEdit[] = []
  let baseCursor = 0
  let changedCursor = 0

  for (const [baseIndex, changedIndex] of matches) {
    if (baseCursor !== baseIndex || changedCursor !== changedIndex) {
      edits.push({
        start: baseCursor,
        end: baseIndex,
        replacement: changed.slice(changedCursor, changedIndex),
      })
    }
    baseCursor = baseIndex + 1
    changedCursor = changedIndex + 1
  }

  if (baseCursor !== base.length || changedCursor !== changed.length) {
    edits.push({
      start: baseCursor,
      end: base.length,
      replacement: changed.slice(changedCursor),
    })
  }
  return edits
}

function mapEditToNext(
  edit: LineEdit,
  matches: Array<[number, number]>,
  nextLength: number
): { nextStart: number; nextEnd: number } {
  const left = [...matches].reverse().find(([baseIndex]) => baseIndex < edit.start)
  const nextStart = left ? left[1] + 1 : 0
  if (edit.start === edit.end) return { nextStart, nextEnd: nextStart }

  const right = matches.find(([baseIndex]) => baseIndex >= edit.end)
  return { nextStart, nextEnd: right ? right[1] : nextLength }
}

function lcsMatches(left: string[], right: string[]): Array<[number, number]> {
  const rows = left.length + 1
  const columns = right.length + 1
  const table = Array.from({ length: rows }, () => Array<number>(columns).fill(0))

  for (let i = left.length - 1; i >= 0; i -= 1) {
    const row = table[i]
    if (!row) continue
    for (let j = right.length - 1; j >= 0; j -= 1) {
      const down = table[i + 1]?.[j] ?? 0
      const across = row[j + 1] ?? 0
      const diagonal = table[i + 1]?.[j + 1] ?? 0
      row[j] = left[i] === right[j] ? diagonal + 1 : Math.max(down, across)
    }
  }

  const matches: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      matches.push([i, j])
      i += 1
      j += 1
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      i += 1
    } else {
      j += 1
    }
  }
  return matches
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}
