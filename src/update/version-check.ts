import process from "node:process"

import { MCP_CONFIG } from "../config.js"

const RELEASES_URL = "https://api.github.com/repos/XiaoPuOuO/openchatx-mcp/releases?per_page=20"
const CACHE_MS = 6 * 60 * 60 * 1_000
const VERSION_PREFIX_PATTERN = /^v/iu
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u
const NUMERIC_IDENTIFIER_PATTERN = /^\d+$/u

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion?: string
  updateAvailable: boolean
  releaseUrl?: string
  downloadUrl?: string
  downloadName?: string
  checkedAt: string
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
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

  const payload: unknown = await response.json()
  const releases = Array.isArray(payload) ? payload.map(asRecord).filter(Boolean) : []
  const currentIsPrerelease = (parseVersion(currentVersion)?.prerelease.length ?? 0) > 0
  const release = releases
    .filter((candidate) => {
      if (!candidate || candidate.draft === true) return false
      if (!currentIsPrerelease && candidate.prerelease === true) return false
      return (
        typeof candidate.tag_name === "string" && parseVersion(candidate.tag_name) !== undefined
      )
    })
    .sort((left, right) =>
      compareVersions(String(right?.tag_name ?? "0.0.0"), String(left?.tag_name ?? "0.0.0"))
    )[0]

  const latestVersion =
    typeof release?.tag_name === "string" ? normalizeVersion(release.tag_name) : undefined
  const releaseUrl = typeof release?.html_url === "string" ? release.html_url : undefined
  const updateAvailable =
    latestVersion !== undefined && compareVersions(latestVersion, currentVersion) > 0
  const asset = updateAvailable ? selectDesktopAsset(release?.assets) : undefined

  return cache({
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseUrl,
    ...(asset ? { downloadUrl: asset.url, downloadName: asset.name } : {}),
    checkedAt,
  })
}

export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const leftVersion = parseVersion(left)
  const rightVersion = parseVersion(right)
  if (!leftVersion || !rightVersion) {
    return compareStrings(normalizeVersion(left), normalizeVersion(right))
  }

  const core = compareCoreVersion(leftVersion, rightVersion)
  return core === 0 ? comparePrerelease(leftVersion.prerelease, rightVersion.prerelease) : core
}

function compareCoreVersion(left: ParsedVersion, right: ParsedVersion): -1 | 0 | 1 {
  for (const difference of [
    left.major - right.major,
    left.minor - right.minor,
    left.patch - right.patch,
  ]) {
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

function comparePrerelease(left: string[], right: string[]): -1 | 0 | 1 {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const result = comparePrereleaseIdentifier(left[index], right[index])
    if (result !== 0) return result
  }
  return 0
}

function comparePrereleaseIdentifier(left?: string, right?: string): -1 | 0 | 1 {
  if (left === undefined && right === undefined) return 0
  if (left === undefined) return -1
  if (right === undefined) return 1
  if (left === right) return 0

  const leftNumeric = NUMERIC_IDENTIFIER_PATTERN.test(left)
  const rightNumeric = NUMERIC_IDENTIFIER_PATTERN.test(right)
  if (leftNumeric && rightNumeric) return compareNumbers(Number(left), Number(right))
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return compareStrings(left, right)
}

function compareNumbers(left: number, right: number): -1 | 0 | 1 {
  if (left === right) return 0
  return left > right ? 1 : -1
}

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  const result = left.localeCompare(right)
  if (result === 0) return 0
  return result > 0 ? 1 : -1
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = SEMVER_PATTERN.exec(normalizeVersion(value))
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  }
}

function normalizeVersion(value: string): string {
  return value.trim().replace(VERSION_PREFIX_PATTERN, "")
}

export function selectDesktopAsset(
  value: unknown,
  platform = process.platform,
  architecture = process.arch
): { name: string; url: string } | undefined {
  if (process.env.OPENCHATX_DESKTOP !== "1" || !Array.isArray(value)) return undefined

  if (platform !== "win32") return undefined
  const arch = architecture === "arm64" ? "arm64" : "x64"
  const expectedName = `OpenChatX-Setup-${arch}.exe`

  for (const raw of value) {
    const asset = asRecord(raw)
    if (
      asset?.name === expectedName &&
      typeof asset.browser_download_url === "string" &&
      asset.browser_download_url.length > 0
    ) {
      return { name: expectedName, url: asset.browser_download_url }
    }
  }
  return undefined
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
