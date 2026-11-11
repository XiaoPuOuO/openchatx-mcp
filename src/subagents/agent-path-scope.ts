import { realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

import type { SubagentModelProfile } from "./config.js"

const PATCH_FILES = /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gmu

function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

/** Resolve through existing symlinks, including paths whose final file does not exist yet. */
async function canonicalPath(root: string, source: string): Promise<string | undefined> {
  if (!source || source.includes("\0")) return undefined
  const absolute = resolve(root, source)
  if (!containsPath(root, absolute)) return undefined
  const segments: string[] = []
  let candidate = absolute
  for (;;) {
    try {
      const existing = await realpath(candidate)
      return resolve(existing, ...segments.reverse())
    } catch (error) {
      if (!isNotFound(error)) return undefined
      const parent = dirname(candidate)
      if (parent === candidate) return undefined
      segments.push(candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
      candidate = parent
    }
  }
}

function fileTargets(
  name: string,
  args: Record<string, unknown>,
  root: string
): string[] | undefined {
  if (name === "file_read" || name === "file_write" || name === "file_edit")
    return typeof args.filePath === "string" ? [args.filePath] : undefined
  if (name === "grep" || name === "glob") {
    const pattern = name === "glob" ? args.pattern : args.include
    if (typeof pattern === "string" && pattern.split("/").includes("..")) return undefined
    return typeof args.path === "string" ? [args.path] : undefined
  }
  if (name === "apply_patch") {
    if (typeof args.patch !== "string") return undefined
    const cwd = typeof args.cwd === "string" ? resolve(root, args.cwd) : root
    const paths = [...args.patch.matchAll(PATCH_FILES)].map((match) => match[1] ?? "")
    return paths.length ? paths.map((path) => resolve(cwd, path)) : undefined
  }
  return []
}

/**
 * An optional allowlist limits only direct, path-addressed file operations.
 * For safety, a path-scoped profile cannot run arbitrary shell, delegation,
 * external MCP, or lazy calls that could bypass this boundary.
 */
export async function agentPathsAllowed(
  profile: Pick<SubagentModelProfile, "allowed_paths">,
  name: string,
  args: Record<string, unknown>,
  projectRoot: string | undefined,
  activeProjectId: string | undefined
): Promise<boolean> {
  if (!profile.allowed_paths?.length) return true
  if (!projectRoot) return false
  if (args.project_id !== undefined && args.project_id !== activeProjectId) return false
  const root = await realpath(projectRoot).catch(() => undefined)
  if (!root) return false
  const allowed = await Promise.all(
    profile.allowed_paths.map((entry) => canonicalPath(root, entry))
  )
  if (allowed.some((path) => !path || !containsPath(root, path))) return false
  const paths = fileTargets(name, args, root)
  if (!paths) return false
  for (const value of paths) {
    const path = await canonicalPath(root, value)
    if (!path || !allowed.some((entry) => entry && containsPath(entry, path))) return false
  }
  return true
}
