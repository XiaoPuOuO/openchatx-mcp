import process from "node:process"

import { z } from "zod"

const repositorySchema = z.object({
  full_name: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  html_url: z.url(),
  default_branch: z.string().min(1),
  stargazers_count: z.number().int().nonnegative(),
  updated_at: z.string(),
  owner: z.object({ login: z.string().min(1) }),
})
const searchSchema = z.object({ items: z.array(repositorySchema) })
const commitSchema = z.object({
  sha: z.string().min(1),
  commit: z.object({ tree: z.object({ sha: z.string().min(1) }) }),
})
const treeItemSchema = z.object({
  path: z.string().min(1),
  mode: z.string(),
  type: z.enum(["blob", "tree", "commit"]),
  sha: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
})
const treeSchema = z.object({
  truncated: z.boolean().default(false),
  tree: z.array(treeItemSchema),
})
const blobSchema = z.object({
  content: z.string(),
  encoding: z.literal("base64"),
  size: z.number().int().nonnegative(),
})

export const communityManifestSchema = z.object({
  schema_version: z.literal(1).default(1),
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  toolbox_path: z.string().min(1).default("."),
  permissions: z
    .object({
      shell: z.boolean().default(false),
      network: z.boolean().default(false),
      filesystem: z.boolean().default(false),
      secrets: z.boolean().default(false),
    })
    .default({ shell: false, network: false, filesystem: false, secrets: false }),
})
export type CommunityManifest = z.infer<typeof communityManifestSchema>
export type GithubTreeItem = z.infer<typeof treeItemSchema>

export interface CommunityRepository {
  id: string
  source: "github"
  repository: string
  owner: string
  name: string
  description: string
  htmlUrl: string
  defaultBranch: string
  stars: number
  updatedAt: string
}

export interface ResolvedCommunityCapability extends CommunityRepository {
  revision: string
  treeSha: string
  manifest: CommunityManifest
}

export interface GithubCommunityStoreOptions {
  apiBase?: string
  token?: string
  fetchImpl?: typeof fetch
}

const COMMUNITY_TOPIC = "openchatx-capability"
const CAPABILITY_MANIFEST = "capability.json"
const TRAILING_SLASH_RE = /\/$/u
const SEARCH_CACHE_MS = 10 * 60 * 1_000
const MAX_TREE_ENTRIES = 1_000
const MAX_BLOB_BYTES = 512 * 1024
const SAFE_RELATIVE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/u

export class GithubCommunityStore {
  private readonly apiBase: string
  private readonly token?: string
  private readonly fetchImpl: typeof fetch
  private searchCache?: { key: string; expiresAt: number; entries: CommunityRepository[] }

  constructor(options: GithubCommunityStoreOptions = {}) {
    this.apiBase = (options.apiBase ?? "https://api.github.com").replace(TRAILING_SLASH_RE, "")
    this.token = options.token ?? process.env.GITHUB_TOKEN
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async search(query = "", limit = 24): Promise<CommunityRepository[]> {
    const normalized = query.trim().toLowerCase()
    const cacheKey = `${normalized}:${limit}`
    if (this.searchCache?.key === cacheKey && this.searchCache.expiresAt > Date.now()) {
      return this.searchCache.entries.map((entry) => ({ ...entry }))
    }

    const q = [`topic:${COMMUNITY_TOPIC}`, query.trim()].filter(Boolean).join(" ")
    const url = new URL(`${this.apiBase}/search/repositories`)
    url.searchParams.set("q", q)
    url.searchParams.set("sort", "stars")
    url.searchParams.set("order", "desc")
    url.searchParams.set("per_page", String(Math.min(Math.max(limit, 1), 50)))
    const payload = searchSchema.parse(await this.requestJson(url))
    const entries = payload.items.map((repo) => repositorySummary(repo))
    this.searchCache = {
      key: cacheKey,
      expiresAt: Date.now() + SEARCH_CACHE_MS,
      entries,
    }
    return entries.map((entry) => ({ ...entry }))
  }

  async resolve(id: string, revision?: string): Promise<ResolvedCommunityCapability> {
    const { owner, repo } = parseCommunityId(id)
    const repository = repositorySchema.parse(
      await this.requestJson(
        new URL(`${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
      )
    )
    const ref = revision?.trim() || repository.default_branch
    const commit = commitSchema.parse(
      await this.requestJson(
        new URL(
          `${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`
        )
      )
    )
    const manifestText = await this.readFileByPath(owner, repo, commit.sha, CAPABILITY_MANIFEST)
    let rawManifest: unknown
    try {
      rawManifest = JSON.parse(manifestText)
    } catch (error) {
      throw new Error(
        `${id} has an invalid ${CAPABILITY_MANIFEST}: ${error instanceof Error ? error.message : "invalid JSON"}`,
        { cause: error }
      )
    }
    const manifest = communityManifestSchema.parse(rawManifest)
    validateToolboxPath(manifest.toolbox_path)
    return {
      ...repositorySummary(repository),
      revision: commit.sha,
      treeSha: commit.commit.tree.sha,
      manifest,
    }
  }

  async tree(capability: ResolvedCommunityCapability): Promise<GithubTreeItem[]> {
    const { owner, repo } = parseCommunityId(capability.id)
    const url = new URL(
      `${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(capability.treeSha)}`
    )
    url.searchParams.set("recursive", "1")
    const payload = treeSchema.parse(await this.requestJson(url))
    if (payload.truncated) {
      throw new Error(`${capability.id} source tree is too large for safe Store inspection.`)
    }
    if (payload.tree.length > MAX_TREE_ENTRIES) {
      throw new Error(
        `${capability.id} has ${payload.tree.length} source entries; the Store limit is ${MAX_TREE_ENTRIES}.`
      )
    }
    return payload.tree.map((item) => ({ ...item }))
  }

  async readFile(capability: ResolvedCommunityCapability, path: string): Promise<string> {
    validateRelativePath(path)
    const tree = await this.tree(capability)
    const item = tree.find((candidate) => candidate.path === path)
    if (item?.type !== "blob") {
      throw new Error(`Source file ${JSON.stringify(path)} does not exist in ${capability.id}.`)
    }
    if (item.mode === "120000") {
      throw new Error("Symlink source entries are not readable through the Capability Store.")
    }
    return this.readBlob(capability, item)
  }

  async readBlob(capability: ResolvedCommunityCapability, item: GithubTreeItem): Promise<string> {
    return (await this.readBlobBytes(capability, item)).toString("utf8")
  }

  async readBlobBytes(
    capability: ResolvedCommunityCapability,
    item: GithubTreeItem
  ): Promise<Buffer> {
    if (item.type !== "blob") throw new Error(`${item.path} is not a file.`)
    if ((item.size ?? 0) > MAX_BLOB_BYTES) {
      throw new Error(
        `${item.path} is larger than the ${MAX_BLOB_BYTES}-byte source inspection limit.`
      )
    }
    const { owner, repo } = parseCommunityId(capability.id)
    const payload = blobSchema.parse(
      await this.requestJson(
        new URL(
          `${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(item.sha)}`
        )
      )
    )
    if (payload.size > MAX_BLOB_BYTES) {
      throw new Error(
        `${item.path} is larger than the ${MAX_BLOB_BYTES}-byte source inspection limit.`
      )
    }
    return Buffer.from(payload.content.replace(/\s+/gu, ""), "base64")
  }

  private async readFileByPath(
    owner: string,
    repo: string,
    revision: string,
    path: string
  ): Promise<string> {
    const url = new URL(
      `${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`
    )
    url.searchParams.set("ref", revision)
    const payload = blobSchema.parse(await this.requestJson(url))
    if (payload.size > MAX_BLOB_BYTES) {
      throw new Error(`${path} exceeds the Capability Store manifest size limit.`)
    }
    return Buffer.from(payload.content.replace(/\s+/gu, ""), "base64").toString("utf8")
  }

  private async requestJson(url: URL): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "openchatx-mcp",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    })
    if (!response.ok) {
      const remaining = response.headers.get("x-ratelimit-remaining")
      const rateHint =
        response.status === 403 && remaining === "0"
          ? " GitHub API rate limit reached; set GITHUB_TOKEN for a higher authenticated limit."
          : ""
      throw new Error(`GitHub request failed (${response.status}) for ${url.pathname}.${rateHint}`)
    }
    return response.json()
  }
}

export function parseCommunityId(id: string): { owner: string; repo: string } {
  if (!id.startsWith("github:")) throw new Error(`Not a GitHub community capability id: ${id}`)
  const repository = id.slice("github:".length)
  const slash = repository.indexOf("/")
  if (slash <= 0 || slash === repository.length - 1 || repository.indexOf("/", slash + 1) !== -1) {
    throw new Error(`Invalid GitHub capability id ${JSON.stringify(id)}.`)
  }
  return { owner: repository.slice(0, slash), repo: repository.slice(slash + 1) }
}

export function validateRelativePath(path: string): void {
  if (!SAFE_RELATIVE_PATH_RE.test(path) || path.includes("\\")) {
    throw new Error(`Unsafe capability path ${JSON.stringify(path)}.`)
  }
}

function validateToolboxPath(path: string): void {
  if (path === ".") return
  validateRelativePath(path)
}

function repositorySummary(repo: z.infer<typeof repositorySchema>): CommunityRepository {
  return {
    id: `github:${repo.full_name}`,
    source: "github",
    repository: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    description: repo.description ?? "Community OpenChatX capability",
    htmlUrl: repo.html_url,
    defaultBranch: repo.default_branch,
    stars: repo.stargazers_count,
    updatedAt: repo.updated_at,
  }
}
