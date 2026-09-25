import type { Dirent, Stats } from "node:fs"
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const MAX_SKILL_BYTES = 256 * 1024
export const MAX_SKILL_SEARCH_RESULTS = 5

const STANDARD_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SAFE_LEGACY_SKILL_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u
const LINE_BREAK_RE = /\r?\n/u
const WORD_RE = /[\p{L}\p{N}]+/gu

export interface SkillSummary {
  name: string
  description?: string
}

export interface LoadedSkill extends Record<string, unknown> {
  name: string
  path: string
  content: string
  description?: string
}

export interface SkillFrontmatter {
  name?: string
  description?: string
}

export class SkillCatalogError extends Error {
  constructor(
    readonly code: "unknown_skill" | "skill_too_large" | "invalid_skill" | "skill_exists",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "SkillCatalogError"
  }
}

export function isValidSkillName(name: string): boolean {
  return name.length <= 64 && STANDARD_SKILL_NAME_PATTERN.test(name)
}

export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const values = parseFrontmatterValues(markdown)
  return {
    ...(values.get("name") ? { name: values.get("name") } : {}),
    ...(values.get("description") ? { description: values.get("description") } : {}),
  }
}

export function renderSkillMarkdown(input: {
  name: string
  description?: string
  body?: string
}): string {
  if (!isValidSkillName(input.name)) throw invalidSkill(input.name, "Invalid standard skill name.")
  const description = input.description?.trim()
  const body = input.body?.trim() || `# ${input.name}\n\nAdd instructions here.`
  return [
    "---",
    `name: ${yamlScalar(input.name)}`,
    `description: ${yamlScalar(description || input.name)}`,
    "---",
    "",
    body,
    "",
  ].join("\n")
}

export class SkillCatalog {
  constructor(readonly root: string) {}

  async list(signal?: AbortSignal): Promise<SkillSummary[]> {
    signal?.throwIfAborted()
    const entries = await this.entries()
    const summaries = await Promise.all(
      entries.map(async (entry): Promise<SkillSummary | undefined> => {
        signal?.throwIfAborted()
        try {
          const loaded = await this.read(entry.name, signal)
          return {
            name: loaded.name,
            ...(loaded.description ? { description: loaded.description } : {}),
          }
        } catch (error) {
          if (
            error instanceof SkillCatalogError &&
            (error.code === "unknown_skill" ||
              error.code === "skill_too_large" ||
              error.code === "invalid_skill")
          ) {
            return undefined
          }
          throw error
        }
      })
    )
    return summaries.filter((summary): summary is SkillSummary => summary !== undefined)
  }

  async search(
    query: string,
    limit = MAX_SKILL_SEARCH_RESULTS,
    signal?: AbortSignal
  ): Promise<SkillSummary[]> {
    const normalizedQuery = query.trim()
    if (!normalizedQuery) return []
    const capped = Math.max(1, Math.min(MAX_SKILL_SEARCH_RESULTS, limit))
    const queryTokens = tokenize(normalizedQuery)

    return (await this.list(signal))
      .map((skill) => ({ skill, score: skillScore(skill, normalizedQuery, queryTokens) }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name)
      )
      .slice(0, capped)
      .map(({ skill }) => skill)
  }

  async read(name: string, signal?: AbortSignal): Promise<LoadedSkill> {
    signal?.throwIfAborted()
    if (!isSafeSkillName(name)) throw unknownSkill(name)

    const path = join(this.root, name, "SKILL.md")
    let fileStat: Stats
    try {
      fileStat = await stat(path)
    } catch (error) {
      if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) {
        throw unknownSkill(name, { cause: error })
      }
      throw error
    }

    if (!fileStat.isFile()) throw unknownSkill(name)
    if (fileStat.size > MAX_SKILL_BYTES) throw skillTooLarge(name)

    const content = await readFile(path, { encoding: "utf8", signal })
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) throw skillTooLarge(name)

    const metadata = parseSkillFrontmatter(content)
    if (metadata.name && metadata.name !== name) {
      throw invalidSkill(
        name,
        `SKILL.md frontmatter name ${JSON.stringify(metadata.name)} must match directory name ${JSON.stringify(name)}.`
      )
    }

    return {
      name,
      path,
      content,
      ...(metadata.description ? { description: metadata.description } : {}),
    }
  }

  async create(input: {
    name: string
    description?: string
    markdown?: string
  }): Promise<LoadedSkill> {
    if (!isValidSkillName(input.name)) {
      throw invalidSkill(
        input.name,
        "Skill names must use lowercase letters, numbers, and single hyphens, with a maximum length of 64 characters."
      )
    }
    const directory = join(this.root, input.name)
    const path = join(directory, "SKILL.md")
    if (await pathExists(path)) {
      throw new SkillCatalogError(
        "skill_exists",
        `Skill ${JSON.stringify(input.name)} already exists.`
      )
    }

    const markdown =
      input.markdown ??
      renderSkillMarkdown({
        name: input.name,
        description: input.description,
      })
    validateManagedMarkdown(input.name, markdown)
    ensureSize(input.name, markdown)
    await mkdir(directory, { recursive: true })
    await writeFile(path, markdown, "utf8")
    return this.read(input.name)
  }

  async edit(
    name: string,
    input: {
      markdown?: string
      description?: string
    }
  ): Promise<LoadedSkill> {
    const current = await this.read(name)
    let markdown = input.markdown
    if (markdown === undefined) {
      const metadata = parseSkillFrontmatter(current.content)
      const body = stripFrontmatter(current.content)
      markdown = renderSkillMarkdown({
        name,
        description: input.description ?? metadata.description,
        body,
      })
    }
    validateManagedMarkdown(name, markdown)
    ensureSize(name, markdown)
    await writeFile(current.path, markdown, "utf8")
    return this.read(name)
  }

  async importDirectory(source: string, options: { replace?: boolean } = {}): Promise<LoadedSkill> {
    const markdownPath = join(source, "SKILL.md")
    const markdown = await readFile(markdownPath, "utf8")
    const metadata = parseSkillFrontmatter(markdown)
    if (!metadata.name || !metadata.description) {
      throw new SkillCatalogError(
        "invalid_skill",
        "Imported skill must contain a SKILL.md with name and description frontmatter."
      )
    }
    if (!isValidSkillName(metadata.name)) {
      throw invalidSkill(
        metadata.name,
        "Imported skill name must use lowercase letters, numbers, and single hyphens, max 64 characters."
      )
    }
    validateManagedMarkdown(metadata.name, markdown)
    ensureSize(metadata.name, markdown)
    await assertNoSymlinks(source)

    const target = join(this.root, metadata.name)
    if (await pathExists(target)) {
      if (!options.replace) {
        throw new SkillCatalogError(
          "skill_exists",
          `Skill ${JSON.stringify(metadata.name)} already exists.`
        )
      }
      await rm(target, { recursive: true, force: true })
    }

    await mkdir(this.root, { recursive: true })
    await cp(source, target, { recursive: true, force: false, errorOnExist: true })
    return this.read(metadata.name)
  }

  async exportDirectory(
    name: string,
    destinationRoot: string,
    options: { replace?: boolean } = {}
  ): Promise<string> {
    await this.read(name)
    const source = join(this.root, name)
    const target = join(destinationRoot, name)
    if (await pathExists(target)) {
      if (!options.replace) {
        throw new SkillCatalogError(
          "skill_exists",
          `Export destination already contains ${JSON.stringify(name)}.`
        )
      }
      await rm(target, { recursive: true, force: true })
    }

    await mkdir(destinationRoot, { recursive: true })
    await cp(source, target, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
    })
    return target
  }

  async delete(name: string): Promise<void> {
    await this.read(name)
    await rm(join(this.root, name), { recursive: true, force: true })
  }

  private async entries(): Promise<Dirent[]> {
    try {
      return (await readdir(this.root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .filter((entry) => isSafeSkillName(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
    } catch (error) {
      if (isFsError(error, "ENOENT")) return []
      throw error
    }
  }
}

function validateManagedMarkdown(name: string, markdown: string): void {
  const metadata = parseSkillFrontmatter(markdown)
  if (!metadata.name) {
    throw invalidSkill(name, "SKILL.md must include frontmatter field 'name'.")
  }
  if (metadata.name !== name) {
    throw invalidSkill(
      name,
      `SKILL.md frontmatter name ${JSON.stringify(metadata.name)} must match ${JSON.stringify(name)}.`
    )
  }
  if (!metadata.description?.trim()) {
    throw invalidSkill(name, "SKILL.md must include frontmatter field 'description'.")
  }
  if (metadata.description.length > 1024) {
    throw invalidSkill(name, "SKILL.md frontmatter description must be 1024 characters or fewer.")
  }
}

function stripFrontmatter(markdown: string): string {
  const lines = markdown.split(LINE_BREAK_RE)
  const firstLine = lines[0] ?? ""
  if (firstLine.trim() !== "---") return markdown.trim()
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "---") continue
    return lines
      .slice(index + 1)
      .join("\n")
      .trim()
  }
  return markdown.trim()
}

function skillScore(skill: SkillSummary, query: string, queryTokens: string[]) {
  const name = skill.name.toLowerCase()
  const description = skill.description?.toLowerCase() ?? ""
  const normalized = query.toLowerCase()
  let score = 0

  if (name === normalized) score += 100
  if (name.includes(normalized)) score += 40
  if (description.includes(normalized)) score += 20

  const nameTokens = new Set(tokenize(name))
  const descriptionTokens = new Set(tokenize(description))
  for (const token of queryTokens) {
    if (nameTokens.has(token)) score += 12
    else if (name.includes(token)) score += 8
    if (descriptionTokens.has(token)) score += 5
    else if (description.includes(token)) score += 2
  }
  return score
}

function tokenize(value: string): string[] {
  return [...value.toLowerCase().matchAll(WORD_RE)].map((match) => match[0]).filter(Boolean)
}

function parseFrontmatterValues(markdown: string): Map<string, string> {
  const values = new Map<string, string>()
  const lines = markdown.split(LINE_BREAK_RE)
  if (lines[0]?.trim() !== "---") return values

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined || line.trim() === "---") break
    const separator = line.indexOf(":")
    if (separator < 0) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    const value = unquote(line.slice(separator + 1).trim())
    values.set(key, value)
  }
  return values
}

function unknownSkill(name: string, options?: ErrorOptions): SkillCatalogError {
  return new SkillCatalogError(
    "unknown_skill",
    `Unknown skill ${JSON.stringify(name)}. Use skill_search to discover matching skills.`,
    options
  )
}

function invalidSkill(name: string, message: string): SkillCatalogError {
  return new SkillCatalogError("invalid_skill", `Invalid skill ${JSON.stringify(name)}: ${message}`)
}

function skillTooLarge(name: string): SkillCatalogError {
  return new SkillCatalogError(
    "skill_too_large",
    `Skill ${JSON.stringify(name)} exceeds the ${MAX_SKILL_BYTES}-byte SKILL.md limit.`
  )
}

function ensureSize(name: string, markdown: string): void {
  if (Buffer.byteLength(markdown, "utf8") > MAX_SKILL_BYTES) throw skillTooLarge(name)
}

function isSafeSkillName(name: string): boolean {
  return SAFE_LEGACY_SKILL_NAME_PATTERN.test(name)
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

async function assertNoSymlinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new SkillCatalogError(
        "invalid_skill",
        `Imported skill contains unsupported symbolic link ${JSON.stringify(entry.name)}.`
      )
    }
    if (entry.isDirectory()) {
      await assertNoSymlinks(join(directory, entry.name))
    }
  }
}

function yamlScalar(value: string): string {
  return JSON.stringify(value)
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
