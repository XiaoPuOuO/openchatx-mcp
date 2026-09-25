import type { Dirent, Stats } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, join, matchesGlob } from "node:path"

export const MAX_RULE_BYTES = 256 * 1024
export const MAX_RULE_RESOLVE_RESULTS = 10

export type RuleMode = "always" | "auto_attached" | "agent_requested" | "manual"

const RULE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const LINE_BREAK_RE = /\r?\n/u
const WORD_RE = /[\p{L}\p{N}]+/gu
const LEADING_DOT_SLASH_RE = /^\.\//u

export interface RuleSummary {
  name: string
  description?: string
  globs: string[]
  alwaysApply: boolean
  mode: RuleMode
  path: string
}

export interface LoadedRule extends RuleSummary {
  markdown: string
  content: string
}

export class RuleCatalogError extends Error {
  constructor(
    readonly code: "unknown_rule" | "invalid_rule" | "rule_exists" | "rule_too_large",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "RuleCatalogError"
  }
}

export class RuleCatalog {
  constructor(readonly root: string) {}

  async list(signal?: AbortSignal): Promise<RuleSummary[]> {
    signal?.throwIfAborted()
    let entries: Dirent[]
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if (isFsError(error, "ENOENT")) return []
      throw error
    }

    const rules = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".mdc"))
        .map(async (entry): Promise<RuleSummary | undefined> => {
          try {
            const rule = await this.load(entry.name.slice(0, -4), signal)
            return summary(rule)
          } catch (error) {
            if (
              error instanceof RuleCatalogError &&
              (error.code === "invalid_rule" || error.code === "rule_too_large")
            ) {
              return undefined
            }
            throw error
          }
        })
    )
    return rules
      .filter((rule): rule is RuleSummary => rule !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async load(name: string, signal?: AbortSignal): Promise<LoadedRule> {
    signal?.throwIfAborted()
    validateRuleName(name)
    const path = join(this.root, `${name}.mdc`)
    let info: Stats
    try {
      info = await stat(path)
    } catch (error) {
      if (isFsError(error, "ENOENT")) throw unknownRule(name, { cause: error })
      throw error
    }
    if (!info.isFile()) throw unknownRule(name)
    if (info.size > MAX_RULE_BYTES) throw ruleTooLarge(name)

    const content = await readFile(path, { encoding: "utf8", signal })
    if (Buffer.byteLength(content, "utf8") > MAX_RULE_BYTES) throw ruleTooLarge(name)
    const parsed = parseMdc(content)
    return {
      name,
      path,
      description: parsed.description,
      globs: parsed.globs,
      alwaysApply: parsed.alwaysApply,
      mode: ruleMode(parsed),
      markdown: parsed.markdown,
      content,
    }
  }

  async alwaysApplied(signal?: AbortSignal): Promise<LoadedRule[]> {
    const summaries = await this.list(signal)
    return Promise.all(
      summaries.filter((rule) => rule.alwaysApply).map((rule) => this.load(rule.name, signal))
    )
  }

  async resolve(
    input: { query?: string; paths?: string[]; limit?: number },
    signal?: AbortSignal
  ): Promise<LoadedRule[]> {
    const query = input.query?.trim() ?? ""
    const paths = (input.paths ?? []).map(normalizePath).filter(Boolean)
    const limit = Math.max(1, Math.min(MAX_RULE_RESOLVE_RESULTS, input.limit ?? 10))
    const queryTokens = tokenize(query)
    const scored: Array<{ rule: RuleSummary; score: number }> = []

    for (const rule of await this.list(signal)) {
      if (rule.alwaysApply) continue
      if (rule.globs.length > 0) {
        const matched = paths.some((path) => rule.globs.some((glob) => matchesRuleGlob(path, glob)))
        if (matched) scored.push({ rule, score: 1_000 })
        continue
      }
      if (!rule.description || !query) continue
      const score = descriptionScore(rule, query, queryTokens)
      if (score > 0) scored.push({ rule, score })
    }

    scored.sort(
      (left, right) => right.score - left.score || left.rule.name.localeCompare(right.rule.name)
    )
    return Promise.all(scored.slice(0, limit).map(({ rule }) => this.load(rule.name, signal)))
  }

  async create(input: {
    name: string
    description?: string
    globs?: string[]
    alwaysApply?: boolean
    markdown?: string
    content?: string
  }): Promise<LoadedRule> {
    validateRuleName(input.name)
    const path = join(this.root, `${input.name}.mdc`)
    if (await pathExists(path)) {
      throw new RuleCatalogError(
        "rule_exists",
        `Rule ${JSON.stringify(input.name)} already exists.`
      )
    }
    const content =
      input.content ??
      renderMdc({
        description: input.description,
        globs: input.globs,
        alwaysApply: input.alwaysApply,
        markdown: input.markdown,
      })
    validateRuleContent(input.name, content)
    ensureSize(input.name, content)
    await mkdir(this.root, { recursive: true })
    await writeFile(path, content, "utf8")
    return this.load(input.name)
  }

  async edit(
    name: string,
    input: {
      description?: string
      globs?: string[]
      alwaysApply?: boolean
      markdown?: string
      content?: string
    }
  ): Promise<LoadedRule> {
    const current = await this.load(name)
    const content =
      input.content ??
      renderMdc({
        description: input.description ?? current.description,
        globs: input.globs ?? current.globs,
        alwaysApply: input.alwaysApply ?? current.alwaysApply,
        markdown: input.markdown ?? current.markdown,
      })
    validateRuleContent(name, content)
    ensureSize(name, content)
    await writeFile(current.path, content, "utf8")
    return this.load(name)
  }

  async delete(name: string): Promise<void> {
    const current = await this.load(name)
    await rm(current.path, { force: true })
  }
}

export function parseMdc(content: string): {
  description?: string
  globs: string[]
  alwaysApply: boolean
  markdown: string
} {
  const lines = content.split(LINE_BREAK_RE)
  if (lines[0]?.trim() !== "---") {
    return { globs: [], alwaysApply: false, markdown: content.trim() }
  }

  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      end = index
      break
    }
  }
  if (end < 0) throw new RuleCatalogError("invalid_rule", "Rule frontmatter is not closed.")

  const metadata = parseRuleFrontmatter(lines.slice(1, end))

  return {
    ...(metadata.description ? { description: metadata.description } : {}),
    globs: metadata.globs,
    alwaysApply: metadata.alwaysApply,
    markdown: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  }
}

function parseRuleFrontmatter(lines: string[]): {
  description?: string
  globs: string[]
  alwaysApply: boolean
} {
  let description: string | undefined
  let alwaysApply = false
  const globs: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    if (raw === undefined) continue
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const separator = line.indexOf(":")
    if (separator < 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()

    if (key === "description") {
      description = unquote(value) || undefined
      continue
    }
    if (key === "alwaysApply") {
      alwaysApply = value.toLowerCase() === "true"
      continue
    }
    if (key !== "globs") continue

    if (value) {
      globs.push(...parseInlineGlobs(value))
      continue
    }
    index = collectBlockGlobs(lines, index + 1, globs)
  }

  return {
    ...(description ? { description } : {}),
    globs: [...new Set(globs)],
    alwaysApply,
  }
}

function collectBlockGlobs(lines: string[], start: number, globs: string[]): number {
  let index = start
  for (; index < lines.length; index += 1) {
    const candidate = lines[index]
    if (candidate === undefined) break
    const trimmed = candidate.trim()
    if (!trimmed.startsWith("-")) return index - 1
    const glob = unquote(trimmed.slice(1).trim())
    if (glob) globs.push(glob)
  }
  return index
}

export function renderMdc(input: {
  description?: string
  globs?: string[]
  alwaysApply?: boolean
  markdown?: string
}): string {
  const lines = ["---"]
  if (input.description?.trim())
    lines.push(`description: ${JSON.stringify(input.description.trim())}`)
  const globs = (input.globs ?? []).map((glob) => glob.trim()).filter(Boolean)
  if (globs.length === 1) lines.push(`globs: ${JSON.stringify(globs[0])}`)
  if (globs.length > 1) {
    lines.push("globs:")
    for (const glob of globs) lines.push(`  - ${JSON.stringify(glob)}`)
  }
  lines.push(`alwaysApply: ${input.alwaysApply === true ? "true" : "false"}`, "---", "")
  lines.push(input.markdown?.trim() || "# Rule\n\nAdd rule instructions here.", "")
  return lines.join("\n")
}

export function ruleMode(input: {
  description?: string
  globs: string[]
  alwaysApply: boolean
}): RuleMode {
  if (input.alwaysApply) return "always"
  if (input.globs.length > 0) return "auto_attached"
  if (input.description?.trim()) return "agent_requested"
  return "manual"
}

function validateRuleContent(name: string, content: string): void {
  const parsed = parseMdc(content)
  if (parsed.alwaysApply) return
  if (parsed.globs.length > 0) return
  if (parsed.description) return
  if (!parsed.markdown) {
    throw new RuleCatalogError("invalid_rule", `Rule ${JSON.stringify(name)} has no Markdown body.`)
  }
}

function summary(rule: LoadedRule): RuleSummary {
  return {
    name: rule.name,
    path: rule.path,
    ...(rule.description ? { description: rule.description } : {}),
    globs: rule.globs,
    alwaysApply: rule.alwaysApply,
    mode: rule.mode,
  }
}

function descriptionScore(rule: RuleSummary, query: string, tokens: string[]) {
  const description = rule.description?.toLowerCase() ?? ""
  const name = rule.name.toLowerCase()
  const normalized = query.toLowerCase()
  let score = 0
  if (name === normalized) score += 100
  if (name.includes(normalized)) score += 40
  if (description.includes(normalized)) score += 30
  for (const token of tokens) {
    if (name.includes(token)) score += 10
    if (description.includes(token)) score += 5
  }
  return score
}

function matchesRuleGlob(path: string, glob: string): boolean {
  try {
    return matchesGlob(path, glob) || matchesGlob(basename(path), glob)
  } catch {
    return false
  }
}

function parseInlineGlobs(value: string): string[] {
  const trimmed = value.trim()
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(trimmed.replace(/'/gu, '"'))
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string")
      }
    } catch {
      // Fall back to comma splitting.
    }
  }
  return trimmed
    .split(",")
    .map((glob) => unquote(glob.trim()))
    .filter(Boolean)
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(LEADING_DOT_SLASH_RE, "")
}

function tokenize(value: string): string[] {
  return [...value.toLowerCase().matchAll(WORD_RE)].map((match) => match[0]).filter(Boolean)
}

function validateRuleName(name: string): void {
  if (!RULE_NAME_PATTERN.test(name)) {
    throw new RuleCatalogError(
      "invalid_rule",
      "Rule names must use lowercase letters, numbers, and single hyphens."
    )
  }
}

function ensureSize(name: string, content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_RULE_BYTES) throw ruleTooLarge(name)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isFsError(error, "ENOENT")) return false
    throw error
  }
}

function unknownRule(name: string, options?: ErrorOptions): RuleCatalogError {
  return new RuleCatalogError("unknown_rule", `Unknown rule ${JSON.stringify(name)}.`, options)
}

function ruleTooLarge(name: string): RuleCatalogError {
  return new RuleCatalogError(
    "rule_too_large",
    `Rule ${JSON.stringify(name)} exceeds the ${MAX_RULE_BYTES}-byte .mdc limit.`
  )
}

function unquote(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }
  return value
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
