import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { z } from "zod"

import { MCP_CONFIG } from "../config.js"
import type { ToolboxRegistry } from "../toolbox/registry.js"
import {
  type CommunityManifest,
  type CommunityRepository,
  communityManifestSchema,
  type GithubCommunityStore,
  type GithubTreeItem,
  type ResolvedCommunityCapability,
  validateRelativePath,
} from "./github-community-store.js"

const entrySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  name: z.string().min(1),
  description: z.string().min(1),
  kind: z.literal("toolbox"),
  bundle: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
})
const catalogSchema = z.object({ entries: z.array(entrySchema) })
const installedSchema = z.object({
  installedAt: z.string(),
  targetPath: z.string(),
  source: z.enum(["builtin", "github"]).optional(),
  revision: z.string().optional(),
})
const stateSchema = z.object({
  installed: z.record(z.string(), installedSchema),
})
const toolboxManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
})
const WHITESPACE_RE = /\s+/u
const TEXT_EXTENSION_RE = /\.(?:cjs|css|html|js|json|jsx|md|mjs|sh|toml|ts|tsx|txt|yaml|yml)$/iu
const SHELL_RE =
  /(?:node:child_process|child_process|\bexec(?:File|Sync)?\s*\(|\bspawn(?:Sync)?\s*\(|\bshell\s*:\s*true)/u
const NETWORK_RE =
  /(?:\bfetch\s*\(|https?:\/\/|node:https?|node:net|node:dgram|WebSocket|EventSource)/u
const FILESYSTEM_RE =
  /(?:node:fs|node:fs\/promises|\bwriteFile|\bappendFile|\brm\s*\(|\bunlink\s*\(|\brename\s*\(|\bchmod\s*\()/u
const SECRETS_RE = /(?:process\.env|Authorization|api[_-]?key|token|secret|password)/iu
const DYNAMIC_CODE_RE = /(?:\beval\s*\(|new\s+Function\s*\()/u
const MAX_REVIEW_FILES = 120
const MAX_REVIEW_BYTES = 2 * 1024 * 1024
const MAX_INSTALL_FILES = 250
const MAX_INSTALL_BYTES = 8 * 1024 * 1024

export interface BuiltinStoreEntry {
  id: string
  source: "builtin"
  name: string
  description: string
  kind: "toolbox"
  bundle: string
  tags: string[]
  installed: boolean
  installedAt?: string
}

export interface CommunityStoreEntry {
  id: string
  source: "github"
  repository: string
  owner: string
  name: string
  description: string
  kind: "toolbox"
  tags: string[]
  installed: boolean
  installedAt?: string
  htmlUrl: string
  defaultBranch: string
  stars: number
  updatedAt: string
  revision?: string
  manifest?: CommunityManifest
}

export type StoreEntry = BuiltinStoreEntry | CommunityStoreEntry

interface StoreState {
  installed: Record<
    string,
    {
      installedAt: string
      targetPath: string
      source?: "builtin" | "github"
      revision?: string
    }
  >
}

export interface StoreBrowseResult {
  entries: StoreEntry[]
  communityError?: string
}

export interface StoreSourceTree {
  capability: StoreEntry
  revision?: string
  files: Array<{ path: string; size?: number }>
}

export interface StoreReviewFinding {
  severity: "info" | "warning" | "high"
  category: "shell" | "network" | "filesystem" | "secrets" | "dynamic-code" | "manifest" | "package"
  path: string
  detail: string
}

export interface StoreReview {
  capability: StoreEntry
  revision?: string
  summary: string
  declaredPermissions?: CommunityManifest["permissions"]
  observedPermissions: {
    shell: boolean
    network: boolean
    filesystem: boolean
    secrets: boolean
  }
  findings: StoreReviewFinding[]
  reviewedFiles: number
  reviewedBytes: number
  note: string
}

interface ReviewSource {
  capability: StoreEntry
  revision?: string
  files: Array<{ path: string; size?: number; item?: GithubTreeItem }>
  read: (file: { path: string; item?: GithubTreeItem }) => Promise<string>
}

interface ReviewScanResult {
  observedPermissions: StoreReview["observedPermissions"]
  findings: StoreReviewFinding[]
  reviewedFiles: number
  reviewedBytes: number
}

export class CapabilityStoreService {
  private readonly statePath: string
  private readonly stagingRoot: string

  constructor(
    private readonly catalogPath: string,
    private readonly bundleRoot: string,
    private readonly toolboxRoot = MCP_CONFIG.toolboxes.root,
    private readonly toolboxRegistry?: ToolboxRegistry,
    stateDir = MCP_CONFIG.stateDir,
    private readonly community?: GithubCommunityStore
  ) {
    this.statePath = join(stateDir, "capability-store.json")
    this.stagingRoot = join(stateDir, "store-staging")
  }

  async list(): Promise<StoreEntry[]> {
    return this.listBuiltin()
  }

  async browse(
    query = "",
    source: "all" | "builtin" | "community" = "all"
  ): Promise<StoreBrowseResult> {
    const entries: StoreEntry[] = []
    if (source !== "community") entries.push(...(await this.searchBuiltin(query)))
    let communityError: string | undefined
    if (source !== "builtin" && this.community) {
      try {
        const repos = await this.community.search(query)
        entries.push(...(await this.communityEntries(repos)))
      } catch (error) {
        communityError = error instanceof Error ? error.message : "Community discovery failed."
      }
    }
    return {
      entries,
      ...(communityError ? { communityError } : {}),
    }
  }

  async search(query: string): Promise<StoreEntry[]> {
    return this.searchBuiltin(query)
  }

  async get(id: string, revision?: string): Promise<StoreEntry> {
    if (id.startsWith("github:")) {
      const resolved = await this.requireCommunity().resolve(id, revision)
      const state = await this.loadState()
      return this.communityEntry(resolved, state)
    }
    const entries = await this.listBuiltin()
    const entry = entries.find((candidate) => candidate.id === id)
    if (!entry) throw new Error(`Unknown Capability Store entry ${JSON.stringify(id)}.`)
    return entry
  }

  async sourceTree(id: string, revision?: string): Promise<StoreSourceTree> {
    if (id.startsWith("github:")) {
      const community = this.requireCommunity()
      const resolved = await community.resolve(id, revision)
      const tree = await community.tree(resolved)
      const state = await this.loadState()
      return {
        capability: this.communityEntry(resolved, state),
        revision: resolved.revision,
        files: tree
          .filter((item) => item.type === "blob")
          .map((item) => ({
            path: item.path,
            ...(item.size === undefined ? {} : { size: item.size }),
          }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      }
    }

    const entry = await this.requireBuiltin(id)
    const root = this.bundlePath(entry.bundle)
    return {
      capability: entry,
      files: await localTree(root),
    }
  }

  async sourceRead(
    id: string,
    path: string,
    revision?: string
  ): Promise<{
    capability: StoreEntry
    revision?: string
    path: string
    content: string
  }> {
    validateRelativePath(path)
    if (id.startsWith("github:")) {
      const community = this.requireCommunity()
      const resolved = await community.resolve(id, revision)
      const content = await community.readFile(resolved, path)
      rejectBinaryText(path, content)
      const state = await this.loadState()
      return {
        capability: this.communityEntry(resolved, state),
        revision: resolved.revision,
        path,
        content,
      }
    }

    const entry = await this.requireBuiltin(id)
    const root = this.bundlePath(entry.bundle)
    const fullPath = safeChild(root, path)
    const content = await readFile(fullPath, "utf8")
    rejectBinaryText(path, content)
    return { capability: entry, path, content }
  }

  async review(id: string, revision?: string): Promise<StoreReview> {
    const source = await this.reviewSource(id, revision)
    const scan = await scanReviewSource(source)
    const declaredPermissions =
      source.capability.source === "github" ? source.capability.manifest?.permissions : undefined
    const findings = [...scan.findings]
    if (declaredPermissions) {
      addPermissionDeclarationFindings(scan.observedPermissions, declaredPermissions, findings)
    }
    const uniqueFindings = dedupeFindings(findings)

    return {
      capability: source.capability,
      ...(source.revision ? { revision: source.revision } : {}),
      summary: reviewSummary(uniqueFindings),
      ...(declaredPermissions ? { declaredPermissions } : {}),
      observedPermissions: scan.observedPermissions,
      findings: uniqueFindings,
      reviewedFiles: scan.reviewedFiles,
      reviewedBytes: scan.reviewedBytes,
      note: "This is static analysis, not a safety verdict. Ask ChatGPT to inspect the cited source files with store_source_read before deciding whether to install.",
    }
  }

  async install(id: string, revision?: string): Promise<StoreEntry> {
    if (id.startsWith("github:")) return this.installCommunity(id, revision)
    return this.installBuiltin(id)
  }

  async uninstall(id: string): Promise<void> {
    const state = await this.loadState()
    const installed = state.installed[id]
    if (!installed) throw new Error(`Capability ${JSON.stringify(id)} is not installed.`)
    const expectedRoot = resolve(this.toolboxRoot)
    const target = resolve(installed.targetPath)
    if (target === expectedRoot || !target.startsWith(`${expectedRoot}${sep}`)) {
      throw new Error(
        `Refusing to remove unexpected Capability Store path ${installed.targetPath}.`
      )
    }
    await rm(target, { recursive: true, force: true })
    delete state.installed[id]
    await this.saveState(state)
    await this.toolboxRegistry?.reload()
  }

  async preparePublish(directory: string): Promise<{
    manifest: CommunityManifest
    topic: string
    requiredFiles: string[]
    instructions: string[]
  }> {
    if (!isAbsolute(directory))
      throw new Error("Publish checks require an absolute directory path.")
    const root = resolve(directory)
    const manifest = communityManifestSchema.parse(
      JSON.parse(await readFile(join(root, "capability.json"), "utf8"))
    )
    const toolboxPath =
      manifest.toolbox_path === "." ? root : safeChild(root, manifest.toolbox_path)
    toolboxManifestSchema.parse(
      JSON.parse(await readFile(join(toolboxPath, "toolbox.json"), "utf8"))
    )
    return {
      manifest,
      topic: "openchatx-capability",
      requiredFiles: ["capability.json", join(manifest.toolbox_path, "toolbox.json")],
      instructions: [
        "Publish this directory in a public GitHub repository.",
        "Add the GitHub repository topic openchatx-capability.",
        "Keep capability.json at the repository root.",
        "OpenChatX Community discovery will find the repository directly from GitHub; no OpenChatX server submission is required.",
      ],
    }
  }

  private async installBuiltin(id: string): Promise<BuiltinStoreEntry> {
    const entry = await this.requireBuiltin(id)
    const state = await this.loadState()
    if (state.installed[id])
      throw new Error(`Capability ${JSON.stringify(id)} is already installed.`)

    const source = this.bundlePath(entry.bundle)
    const target = join(this.toolboxRoot, entry.id)
    if (await pathExists(target))
      throw new Error(`Cannot install ${JSON.stringify(id)} because ${target} already exists.`)

    await mkdir(this.toolboxRoot, { recursive: true })
    await cp(source, target, { recursive: true, errorOnExist: true, force: false })
    const installedAt = new Date().toISOString()
    state.installed[id] = { installedAt, targetPath: target, source: "builtin" }
    await this.saveState(state)
    await this.toolboxRegistry?.reload()
    return { ...entry, installed: true, installedAt }
  }

  private async installCommunity(id: string, revision?: string): Promise<CommunityStoreEntry> {
    const community = this.requireCommunity()
    const resolved = await community.resolve(id, revision)
    const state = await this.loadState()
    if (state.installed[id])
      throw new Error(`Capability ${JSON.stringify(id)} is already installed.`)

    const tree = await community.tree(resolved)
    const files = installFiles(tree, resolved.manifest.toolbox_path)
    if (!files.some((file) => file.installPath === "toolbox.json")) {
      throw new Error(
        `${id}@${resolved.revision} does not contain toolbox.json at ${resolved.manifest.toolbox_path}.`
      )
    }
    if (files.length > MAX_INSTALL_FILES) {
      throw new Error(`Community capability exceeds the ${MAX_INSTALL_FILES}-file install limit.`)
    }
    const totalBytes = files.reduce((sum, file) => sum + (file.item.size ?? 0), 0)
    if (totalBytes > MAX_INSTALL_BYTES) {
      throw new Error(`Community capability exceeds the ${MAX_INSTALL_BYTES}-byte install limit.`)
    }

    const targetId = communityToolboxId(resolved.repository)
    const target = join(this.toolboxRoot, targetId)
    if (await pathExists(target)) {
      throw new Error(`Cannot install ${id}; Toolbox directory ${target} already exists.`)
    }

    const stage = join(this.stagingRoot, `${targetId}-${resolved.revision.slice(0, 12)}`)
    await rm(stage, { recursive: true, force: true })
    await mkdir(stage, { recursive: true, mode: 0o700 })
    try {
      for (const file of files) {
        const bytes = await community.readBlobBytes(resolved, file.item)
        const outputPath = safeChild(stage, file.installPath)
        await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
        await writeFile(outputPath, bytes, { mode: 0o600 })
      }
      toolboxManifestSchema.parse(JSON.parse(await readFile(join(stage, "toolbox.json"), "utf8")))
      await mkdir(this.toolboxRoot, { recursive: true })
      await rename(stage, target)
    } catch (error) {
      await rm(stage, { recursive: true, force: true })
      throw error
    }

    const installedAt = new Date().toISOString()
    state.installed[id] = {
      installedAt,
      targetPath: target,
      source: "github",
      revision: resolved.revision,
    }
    await this.saveState(state)
    await this.toolboxRegistry?.reload()
    return {
      ...this.communityEntry(resolved, state),
      installed: true,
      installedAt,
      revision: resolved.revision,
    }
  }

  private async listBuiltin(): Promise<BuiltinStoreEntry[]> {
    const [catalog, state] = await Promise.all([this.loadCatalog(), this.loadState()])
    return catalog.entries.map((entry) => {
      const installed = state.installed[entry.id]
      return {
        ...entry,
        source: "builtin" as const,
        installed: Boolean(installed),
        ...(installed ? { installedAt: installed.installedAt } : {}),
      }
    })
  }

  private async searchBuiltin(query: string): Promise<BuiltinStoreEntry[]> {
    const terms = query.toLowerCase().split(WHITESPACE_RE).filter(Boolean)
    const entries = await this.listBuiltin()
    if (terms.length === 0) return entries
    return entries.filter((entry) => {
      const haystack = [entry.id, entry.name, entry.description, ...entry.tags]
        .join(" ")
        .toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }

  private async communityEntries(repos: CommunityRepository[]): Promise<CommunityStoreEntry[]> {
    const state = await this.loadState()
    return repos.map((repo) => {
      const installed = state.installed[repo.id]
      return {
        ...repo,
        kind: "toolbox" as const,
        tags: [],
        installed: Boolean(installed),
        ...(installed ? { installedAt: installed.installedAt } : {}),
        ...(installed?.revision ? { revision: installed.revision } : {}),
      }
    })
  }

  private communityEntry(
    resolved: ResolvedCommunityCapability,
    state: StoreState
  ): CommunityStoreEntry {
    const installed = state.installed[resolved.id]
    return {
      id: resolved.id,
      source: "github",
      repository: resolved.repository,
      owner: resolved.owner,
      name: resolved.manifest.name,
      description: resolved.manifest.description,
      kind: "toolbox",
      tags: resolved.manifest.tags,
      installed: Boolean(installed),
      ...(installed ? { installedAt: installed.installedAt } : {}),
      htmlUrl: resolved.htmlUrl,
      defaultBranch: resolved.defaultBranch,
      stars: resolved.stars,
      updatedAt: resolved.updatedAt,
      revision: resolved.revision,
      manifest: resolved.manifest,
    }
  }

  private async requireBuiltin(id: string): Promise<BuiltinStoreEntry> {
    const entry = (await this.listBuiltin()).find((candidate) => candidate.id === id)
    if (!entry) throw new Error(`Unknown built-in Capability Store entry ${JSON.stringify(id)}.`)
    return entry
  }

  private requireCommunity(): GithubCommunityStore {
    if (!this.community) {
      throw new Error("GitHub Community capability discovery is unavailable.")
    }
    return this.community
  }

  private async reviewSource(id: string, revision?: string): Promise<ReviewSource> {
    if (id.startsWith("github:")) {
      const community = this.requireCommunity()
      const resolved = await community.resolve(id, revision)
      const tree = await community.tree(resolved)
      const state = await this.loadState()
      return {
        capability: this.communityEntry(resolved, state),
        revision: resolved.revision,
        files: tree
          .filter((item) => item.type === "blob" && item.mode !== "120000")
          .map((item) => ({ path: item.path, size: item.size, item })),
        read: async (file) => {
          if (!file.item) throw new Error("Missing source item.")
          return community.readBlob(resolved, file.item)
        },
      }
    }

    const entry = await this.requireBuiltin(id)
    const root = this.bundlePath(entry.bundle)
    const files = await localTree(root)
    return {
      capability: entry,
      files,
      read: async (file) => readFile(safeChild(root, file.path), "utf8"),
    }
  }

  private async loadCatalog() {
    return catalogSchema.parse(JSON.parse(await readFile(this.catalogPath, "utf8")))
  }

  private async loadState(): Promise<StoreState> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")))
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { installed: {} }
      }
      throw error
    }
  }

  private async saveState(state: StoreState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
  }

  private bundlePath(bundle: string): string {
    if (basename(bundle) !== bundle)
      throw new Error("Capability Store bundle names cannot contain paths.")
    return join(this.bundleRoot, bundle)
  }
}

function installFiles(
  tree: GithubTreeItem[],
  toolboxPath: string
): Array<{ item: GithubTreeItem; installPath: string }> {
  const prefix = toolboxPath === "." ? "" : `${toolboxPath}/`
  const selected: Array<{ item: GithubTreeItem; installPath: string }> = []
  for (const item of tree) {
    const inRoot = prefix ? item.path.startsWith(prefix) : true
    if (!inRoot) continue
    if (item.type === "commit") {
      throw new Error(
        `Community capability contains a git submodule at ${item.path}; submodules are not installable.`
      )
    }
    if (item.type !== "blob") continue
    if (item.mode === "120000") {
      throw new Error(
        `Community capability contains a symlink at ${item.path}; symlinks are not installable.`
      )
    }
    const installPath = prefix ? item.path.slice(prefix.length) : item.path
    if (!installPath || installPath === "capability.json") continue
    validateRelativePath(installPath)
    selected.push({ item, installPath })
  }
  return selected
}

async function localTree(root: string): Promise<Array<{ path: string; size?: number }>> {
  const files: Array<{ path: string; size?: number }> = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(fullPath)
      files.push({ path: relative(root, fullPath).split(sep).join("/"), size: info.size })
    }
  }
  await walk(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function safeChild(root: string, child: string): string {
  const resolvedRoot = resolve(root)
  const resolvedChild = resolve(root, child)
  if (resolvedChild === resolvedRoot || !resolvedChild.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Unsafe capability path ${JSON.stringify(child)}.`)
  }
  return resolvedChild
}

function communityToolboxId(repository: string): string {
  const normalized = `gh-${repository}`
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .slice(0, 120)
  if (!normalized) throw new Error(`Could not derive Toolbox id from ${repository}.`)
  return normalized
}

function isReviewableText(path: string): boolean {
  return (
    TEXT_EXTENSION_RE.test(path) ||
    basename(path) === "package.json" ||
    basename(path) === "toolbox.json"
  )
}

function rejectBinaryText(path: string, content: string): void {
  if (content.includes("\0")) throw new Error(`${path} appears to be binary.`)
}

async function scanReviewSource(source: ReviewSource): Promise<ReviewScanResult> {
  const observedPermissions: StoreReview["observedPermissions"] = {
    shell: false,
    network: false,
    filesystem: false,
    secrets: false,
  }
  const findings: StoreReviewFinding[] = []
  let reviewedFiles = 0
  let reviewedBytes = 0

  for (const file of source.files) {
    if (reviewedFiles >= MAX_REVIEW_FILES || reviewedBytes >= MAX_REVIEW_BYTES) break
    if (!isReviewableText(file.path)) continue
    const content = await readReviewFile(source, file)
    if (content === undefined) continue
    const bytes = Buffer.byteLength(content)
    if (reviewedBytes + bytes > MAX_REVIEW_BYTES) break
    reviewedFiles += 1
    reviewedBytes += bytes
    inspectSourceFile(file.path, content, observedPermissions, findings)
  }

  return { observedPermissions, findings, reviewedFiles, reviewedBytes }
}

async function readReviewFile(
  source: ReviewSource,
  file: ReviewSource["files"][number]
): Promise<string | undefined> {
  try {
    return await source.read(file)
  } catch {
    return undefined
  }
}

function inspectSourceFile(
  path: string,
  content: string,
  observed: StoreReview["observedPermissions"],
  findings: StoreReviewFinding[]
): void {
  inspectPattern({
    path,
    content,
    pattern: SHELL_RE,
    permission: "shell",
    severity: "warning",
    observed,
    findings,
  })
  inspectPattern({
    path,
    content,
    pattern: NETWORK_RE,
    permission: "network",
    severity: "info",
    observed,
    findings,
  })
  inspectPattern({
    path,
    content,
    pattern: FILESYSTEM_RE,
    permission: "filesystem",
    severity: "info",
    observed,
    findings,
  })
  inspectPattern({
    path,
    content,
    pattern: SECRETS_RE,
    permission: "secrets",
    severity: "warning",
    observed,
    findings,
  })
  if (DYNAMIC_CODE_RE.test(content)) {
    findings.push({
      severity: "high",
      category: "dynamic-code",
      path,
      detail: "Source contains dynamic code execution via eval or Function.",
    })
  }
  if (basename(path) === "package.json") inspectPackageJson(path, content, findings)
}

function inspectPattern({
  path,
  content,
  pattern,
  permission,
  severity,
  observed,
  findings,
}: {
  path: string
  content: string
  pattern: RegExp
  permission: keyof StoreReview["observedPermissions"]
  severity: StoreReviewFinding["severity"]
  observed: StoreReview["observedPermissions"]
  findings: StoreReviewFinding[]
}): void {
  if (!pattern.test(content)) return
  observed[permission] = true
  const details: Record<keyof StoreReview["observedPermissions"], string> = {
    shell: "Source references process or shell execution.",
    network: "Source contains network access indicators.",
    filesystem: "Source contains filesystem access indicators.",
    secrets: "Source references environment variables, credentials, or authorization values.",
  }
  findings.push({
    severity,
    category: permission,
    path,
    detail: details[permission],
  })
}

function addPermissionDeclarationFindings(
  observed: StoreReview["observedPermissions"],
  declared: CommunityManifest["permissions"],
  findings: StoreReviewFinding[]
): void {
  for (const permission of ["shell", "network", "filesystem", "secrets"] as const) {
    if (!observed[permission] || declared[permission]) continue
    findings.push({
      severity: "warning",
      category: "manifest",
      path: "capability.json",
      detail: `Observed ${permission} behavior is not declared in capability.json permissions.`,
    })
  }
}

function reviewSummary(findings: StoreReviewFinding[]) {
  if (findings.some((finding) => finding.severity === "high")) {
    return "High-risk code patterns require manual inspection."
  }
  if (findings.some((finding) => finding.severity === "warning")) {
    return "Potential risks were detected; inspect the cited source files before installing."
  }
  return "No obvious high-risk patterns were found in the reviewed text files."
}

function inspectPackageJson(path: string, content: string, findings: StoreReviewFinding[]): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    findings.push({
      severity: "warning",
      category: "package",
      path,
      detail: "package.json is not valid JSON.",
    })
    return
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return
  const scripts = "scripts" in parsed ? parsed.scripts : undefined
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return
  for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
    if (!(name in scripts)) continue
    findings.push({
      severity: "warning",
      category: "package",
      path,
      detail: `package.json defines a ${name} lifecycle script.`,
    })
  }
}

function dedupeFindings(findings: StoreReviewFinding[]): StoreReviewFinding[] {
  const seen = new Set<string>()
  return findings.filter((finding) => {
    const key = `${finding.severity}\0${finding.category}\0${finding.path}\0${finding.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}
