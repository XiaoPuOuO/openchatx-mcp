import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname } from "node:path"

import {
  type LoadedRule,
  parseMdc,
  type RuleCatalog,
  RuleCatalogError,
  type RuleMode,
  renderMdc,
} from "./rule-catalog.js"

const LINE_BREAK_RE = /\r?\n/u

export type RuleExternalFormat = "cursor" | "claude" | "agents"

export interface RuleImportOptions {
  format: RuleExternalFormat
  source: string
  name?: string
  replace?: boolean
  description?: string
  globs?: string[]
  mode?: RuleMode
}

export interface RuleExportOptions {
  format: RuleExternalFormat
  name: string
  destination: string
  replace?: boolean
  allowLossy?: boolean
}

export interface RuleExportResult {
  path: string
  format: RuleExternalFormat
  mode: RuleMode
  warnings: string[]
}

export async function importRule(
  catalog: RuleCatalog,
  options: RuleImportOptions
): Promise<LoadedRule> {
  const source = await readFile(options.source, "utf8")
  const imported = parseExternalRule(options.format, source)
  const name = options.name?.trim() || deriveRuleName(options.source)
  const resolved = applyImportOverrides(imported, options)

  if (options.replace) {
    try {
      await catalog.delete(name)
    } catch (error) {
      if (!(error instanceof RuleCatalogError) || error.code !== "unknown_rule") throw error
    }
  }

  return catalog.create({
    name,
    ...(resolved.description ? { description: resolved.description } : {}),
    globs: resolved.globs,
    alwaysApply: resolved.alwaysApply,
    markdown: resolved.markdown,
  })
}

export async function exportRule(
  catalog: RuleCatalog,
  options: RuleExportOptions
): Promise<RuleExportResult> {
  const rule = await catalog.load(options.name)
  const rendered = renderExternalRule(rule, options.format, options.allowLossy === true)
  await ensureDestinationWritable(options.destination, options.replace === true)
  await mkdir(dirname(options.destination), { recursive: true })
  await writeFile(options.destination, rendered.content, "utf8")
  return {
    path: options.destination,
    format: options.format,
    mode: rule.mode,
    warnings: rendered.warnings,
  }
}

export function parseExternalRule(
  format: RuleExternalFormat,
  content: string
): {
  description?: string
  globs: string[]
  alwaysApply: boolean
  markdown: string
} {
  if (format === "cursor") return parseMdc(content)
  if (format === "claude") return parseClaudeRule(content)
  return {
    globs: [],
    alwaysApply: true,
    markdown: content.trim(),
  }
}

export function renderExternalRule(
  rule: Pick<LoadedRule, "description" | "globs" | "alwaysApply" | "markdown" | "mode">,
  format: RuleExternalFormat,
  allowLossy: boolean
): { content: string; warnings: string[] } {
  if (format === "cursor") {
    return {
      content: renderMdc({
        description: rule.description,
        globs: rule.globs,
        alwaysApply: rule.alwaysApply,
        markdown: rule.markdown,
      }),
      warnings: [],
    }
  }

  if (format === "claude") return renderClaudeRule(rule, allowLossy)
  return renderAgentsRule(rule, allowLossy)
}

function parseClaudeRule(content: string): {
  description?: string
  globs: string[]
  alwaysApply: boolean
  markdown: string
} {
  const parsed = parseSimpleFrontmatter(content)
  const paths =
    parsed.arrays.get("paths") ??
    (parsed.values.get("paths") ? parsePathValue(parsed.values.get("paths") ?? "") : [])
  const description = parsed.values.get("description")
  return {
    ...(description ? { description } : {}),
    globs: paths,
    alwaysApply: paths.length === 0,
    markdown: parsed.markdown,
  }
}

function renderClaudeRule(
  rule: Pick<LoadedRule, "description" | "globs" | "markdown" | "mode">,
  allowLossy: boolean
): { content: string; warnings: string[] } {
  if (rule.mode === "always") return { content: `${rule.markdown.trim()}\n`, warnings: [] }
  if (rule.mode === "auto_attached") {
    const lines = ["---", "paths:"]
    for (const glob of rule.globs) lines.push(`  - ${JSON.stringify(glob)}`)
    lines.push("---", "", rule.markdown.trim(), "")
    return { content: lines.join("\n"), warnings: [] }
  }

  const warning =
    rule.mode === "agent_requested"
      ? "Claude .claude/rules does not preserve Agent Requested activation; exported rule will load as an always-applied rule."
      : "Claude .claude/rules does not preserve Manual activation; exported rule will load as an always-applied rule."
  if (!allowLossy) throw unsupportedExport("claude", rule.mode, warning)
  return { content: `${rule.markdown.trim()}\n`, warnings: [warning] }
}

function renderAgentsRule(
  rule: Pick<LoadedRule, "markdown" | "mode">,
  allowLossy: boolean
): { content: string; warnings: string[] } {
  if (rule.mode === "always") return { content: `${rule.markdown.trim()}\n`, warnings: [] }
  const warning = `AGENTS.md uses directory scope and cannot preserve ${displayMode(rule.mode)} activation metadata; exported content will apply whenever that AGENTS.md is in scope.`
  if (!allowLossy) throw unsupportedExport("agents", rule.mode, warning)
  return { content: `${rule.markdown.trim()}\n`, warnings: [warning] }
}

function parsePathValue(value: string): string[] {
  const trimmed = value.trim()
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(trimmed.replace(/'/gu, '"'))
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string")
      }
    } catch {
      // Fall through to comma-separated parsing.
    }
  }
  return trimmed
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter(Boolean)
}

function applyImportOverrides(
  imported: {
    description?: string
    globs: string[]
    alwaysApply: boolean
    markdown: string
  },
  options: Pick<RuleImportOptions, "description" | "globs" | "mode">
): {
  description?: string
  globs: string[]
  alwaysApply: boolean
  markdown: string
} {
  let result = {
    ...imported,
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.globs !== undefined ? { globs: options.globs } : {}),
  }

  if (options.mode) result = applyMode(result, options.mode)
  return result
}

function applyMode(
  input: {
    description?: string
    globs: string[]
    alwaysApply: boolean
    markdown: string
  },
  mode: RuleMode
) {
  if (mode === "always") return { ...input, alwaysApply: true }
  if (mode === "auto_attached") {
    if (input.globs.length === 0) {
      throw new RuleCatalogError("invalid_rule", "Auto Attached rules require at least one glob.")
    }
    return { ...input, alwaysApply: false }
  }
  if (mode === "agent_requested") {
    if (!input.description?.trim()) {
      throw new RuleCatalogError(
        "invalid_rule",
        "Agent Requested rules require a non-empty description."
      )
    }
    return { ...input, alwaysApply: false, globs: [] }
  }
  return { ...input, alwaysApply: false, globs: [], description: undefined }
}

function parseSimpleFrontmatter(content: string): {
  values: Map<string, string>
  arrays: Map<string, string[]>
  markdown: string
} {
  const lines = content.split(LINE_BREAK_RE)
  if (lines[0]?.trim() !== "---") {
    return { values: new Map(), arrays: new Map(), markdown: content.trim() }
  }

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end < 0) {
    throw new RuleCatalogError("invalid_rule", "Markdown frontmatter is not closed.")
  }

  const values = new Map<string, string>()
  const arrays = new Map<string, string[]>()
  for (let index = 1; index < end; index += 1) {
    const raw = lines[index]
    if (raw === undefined) continue
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const separator = trimmed.indexOf(":")
    if (separator < 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if (value) {
      values.set(key, unquote(value))
      continue
    }

    const list: string[] = []
    for (index += 1; index < end; index += 1) {
      const item = lines[index]?.trim() ?? ""
      if (!item.startsWith("-")) {
        index -= 1
        break
      }
      const itemValue = unquote(item.slice(1).trim())
      if (itemValue) list.push(itemValue)
    }
    arrays.set(key, list)
  }

  return {
    values,
    arrays,
    markdown: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  }
}

function deriveRuleName(source: string): string {
  const filename = basename(source, extname(source))
  const parent = basename(dirname(source))
  const raw = filename.toLowerCase() === "agents" ? parent : filename
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
  if (!normalized) {
    throw new RuleCatalogError("invalid_rule", "Could not derive a rule name from source path.")
  }
  return normalized
}

async function ensureDestinationWritable(path: string, replace: boolean): Promise<void> {
  try {
    await stat(path)
    if (!replace) {
      throw new RuleCatalogError(
        "rule_exists",
        `Export destination ${JSON.stringify(path)} already exists.`
      )
    }
  } catch (error) {
    if (error instanceof RuleCatalogError) throw error
    if (isFsError(error, "ENOENT")) return
    throw error
  }
}

function unsupportedExport(format: RuleExternalFormat, mode: RuleMode, detail: string) {
  return new RuleCatalogError(
    "invalid_rule",
    `Cannot losslessly export ${displayMode(mode)} rule to ${format}: ${detail} Set allow_lossy=true to export the Markdown body with changed activation semantics.`
  )
}

function displayMode(mode: RuleMode) {
  if (mode === "always") return "Always"
  if (mode === "auto_attached") return "Auto Attached"
  if (mode === "agent_requested") return "Agent Requested"
  return "Manual"
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
