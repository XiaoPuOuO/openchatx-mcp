const PATCH_LINE_SEPARATOR = /\r?\n/u

interface PatchHunk {
  index: number
  context?: string
  expected: string[]
}

interface PatchSection {
  kind: "add" | "update" | "delete"
  path: string
  moveTo?: string
  additions: number
  deletions: number
  hunks: PatchHunk[]
}

export interface PatchExecutionSummary {
  changed?: string
  failed?: string
}

/**
 * Interpret the submitted patch together with the native binary's outcome.
 *
 * The vendored binary applies file sections in order and reports only the first failure. This
 * module owns openchatx-mcp's dependency on that ordering and diagnostic format so process execution
 * does not need to understand patch grammar.
 */
export function summarizePatchExecution(
  patch: string,
  succeeded: boolean,
  output: string
): PatchExecutionSummary {
  const sections = parsePatchSections(patch)
  const failedIndex = succeeded ? -1 : findFailedSectionIndex(output, sections)
  let changedSections: readonly PatchSection[] = []
  if (succeeded) changedSections = sections
  else if (failedIndex >= 0) changedSections = sections.slice(0, failedIndex)
  const changed = summarizeChanges(changedSections)
  const failedSection = failedIndex >= 0 ? sections[failedIndex] : undefined
  const failed = failedSection ? summarizeFailure(output, failedSection) : undefined
  return {
    ...(changed ? { changed } : {}),
    ...(failed ? { failed } : {}),
  }
}

function parsePatchSections(patch: string): PatchSection[] {
  const sections: PatchSection[] = []
  let section: PatchSection | undefined
  let hunk: PatchHunk | undefined

  for (const line of patch.split(PATCH_LINE_SEPARATOR)) {
    const nextSection = parseSectionHeader(line)
    if (nextSection) {
      section = nextSection
      sections.push(nextSection)
      hunk = undefined
      continue
    }
    if (!section) continue
    hunk = consumePatchLine(line, section, hunk)
  }

  return sections.filter((candidate) => candidate.path.length > 0)
}

function parseSectionHeader(line: string): PatchSection | undefined {
  const headers: Array<[string, PatchSection["kind"]]> = [
    ["*** Add File: ", "add"],
    ["*** Update File: ", "update"],
    ["*** Delete File: ", "delete"],
  ]
  for (const [prefix, kind] of headers) {
    if (line.startsWith(prefix)) {
      return { kind, path: line.slice(prefix.length).trim(), additions: 0, deletions: 0, hunks: [] }
    }
  }
  return undefined
}

function consumePatchLine(
  line: string,
  section: PatchSection,
  currentHunk: PatchHunk | undefined
): PatchHunk | undefined {
  if (section.kind === "update" && line.startsWith("*** Move to: ")) {
    section.moveTo = line.slice("*** Move to: ".length).trim()
    return currentHunk
  }
  if (section.kind === "update" && (line === "@@" || line.startsWith("@@ "))) {
    const hunk: PatchHunk = {
      index: section.hunks.length + 1,
      ...(line.length > 2 ? { context: line.slice(3) } : {}),
      expected: [],
    }
    section.hunks.push(hunk)
    return hunk
  }
  if (line === "*** End of File" || line === "*** End Patch") return currentHunk
  if (section.kind === "add") {
    if (line.startsWith("+")) section.additions += 1
    return currentHunk
  }

  const prefix = line[0]
  if (section.kind !== "update" || (prefix !== " " && prefix !== "+" && prefix !== "-")) {
    return currentHunk
  }

  const hunk = currentHunk ?? { index: section.hunks.length + 1, expected: [] }
  if (!currentHunk) section.hunks.push(hunk)
  if (prefix === "+") section.additions += 1
  if (prefix === "-") section.deletions += 1
  if (prefix === " " || prefix === "-") hunk.expected.push(line.slice(1))
  return hunk
}

function summarizeChanges(sections: readonly PatchSection[]): string | undefined {
  const changed = sections.flatMap((section) => {
    if (section.kind === "add")
      return [`${section.path}${formatCounts(section.additions, 0) || " added"}`]
    if (section.kind === "delete") return [`${section.path} deleted`]
    if (section.moveTo)
      return [
        `${section.path} -> ${section.moveTo}${formatCounts(section.additions, section.deletions)}`,
      ]
    const counts = formatCounts(section.additions, section.deletions)
    return counts ? [`${section.path}${counts}`] : []
  })
  return changed.length > 0 ? changed.join("\n") : undefined
}

function formatCounts(additions: number, deletions: number): string {
  const parts: string[] = []
  if (additions > 0) parts.push(`+${additions}`)
  if (deletions > 0) parts.push(`-${deletions}`)
  return parts.length > 0 ? ` ${parts.join(" ")}` : ""
}

function findFailedSectionIndex(output: string, sections: readonly PatchSection[]): number {
  const headline = output.split("\n", 1)[0] ?? output
  let match = -1
  let matchLength = -1
  for (const [index, section] of sections.entries()) {
    for (const path of [section.path, section.moveTo]) {
      if (path && path.length > matchLength && headline.includes(path)) {
        match = index
        matchLength = path.length
      }
    }
  }
  return match
}

function summarizeFailure(output: string, section: PatchSection): string {
  const displayPath = section.moveTo ? `${section.path} -> ${section.moveTo}` : section.path
  if (section.kind !== "update" || section.hunks.length === 0) return displayPath

  const hunk = identifyFailedHunk(output, section.hunks)
  if (!hunk) return displayPath
  return hunk.context ? `${displayPath} @@ ${hunk.context}` : `${displayPath} hunk ${hunk.index}`
}

function identifyFailedHunk(output: string, hunks: readonly PatchHunk[]): PatchHunk | undefined {
  for (const hunk of hunks) {
    if (hunk.context && output.includes(`context '${hunk.context}'`)) return hunk
  }

  const body = output.split("\n").slice(1).join("\n").trim()
  if (body) {
    const scored = hunks
      .map((hunk) => ({
        hunk,
        score: hunk.expected.filter((line) => line.length > 0 && body.includes(line)).length,
      }))
      .sort((left, right) => right.score - left.score)
    if (
      scored[0] &&
      scored[0].score > 0 &&
      (scored.length === 1 || (scored[1] !== undefined && scored[0].score > scored[1].score))
    )
      return scored[0].hunk
  }

  return hunks.length === 1 ? hunks[0] : undefined
}
