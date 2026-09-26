import { MCP_CONFIG } from "../config.js"

const RELEASES_URL = "https://api.github.com/repos/XiaoPuOuO/openchatx-mcp/releases/latest"
const CACHE_MS = 6 * 60 * 60 * 1_000
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)/u
const VERSION_PREFIX_PATTERN = /^v/iu

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion?: string
  updateAvailable: boolean
  releaseUrl?: string
  checkedAt: string
}

let cached: { expiresAt: number; value: UpdateCheckResult } | undefined

export async function checkForOpenChatXUpdate(force = false): Promise<UpdateCheckResult> {
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value

  const currentVersion = MCP_CONFIG.server.version
  const checkedAt = new Date().toISOString()
  const response = await fetch(RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `OpenChatX/${currentVersion}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(8_000),
  })

  if (response.status === 404) {
    return cache({ currentVersion, updateAvailable: false, checkedAt })
  }
  if (!response.ok) {
    throw new Error(`GitHub release check failed with HTTP ${response.status}.`)
  }

  const release = asRecord(await response.json())
  const latestVersion =
    typeof release?.tag_name === "string" ? normalizeVersion(release.tag_name) : undefined
  const releaseUrl = typeof release?.html_url === "string" ? release.html_url : undefined
  const updateAvailable =
    latestVersion !== undefined &&
    release?.draft !== true &&
    release?.prerelease !== true &&
    compareVersions(latestVersion, currentVersion) > 0

  return cache({
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseUrl,
    checkedAt,
  })
}

export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const [leftMajor, leftMinor, leftPatch] = parseVersion(left)
  const [rightMajor, rightMinor, rightPatch] = parseVersion(right)
  for (const difference of [
    leftMajor - rightMajor,
    leftMinor - rightMinor,
    leftPatch - rightPatch,
  ]) {
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

function parseVersion(value: string): [number, number, number] {
  const normalized = normalizeVersion(value)
  const parts = SEMVER_PATTERN.exec(normalized)?.slice(1, 4) ?? []
  return [Number(parts[0] ?? 0), Number(parts[1] ?? 0), Number(parts[2] ?? 0)]
}

function normalizeVersion(value: string): string {
  return value.trim().replace(VERSION_PREFIX_PATTERN, "")
}

function cache(value: UpdateCheckResult): UpdateCheckResult {
  cached = { value, expiresAt: Date.now() + CACHE_MS }
  return value
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}
