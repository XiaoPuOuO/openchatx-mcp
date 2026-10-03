import { stat } from "node:fs/promises"

export function communityToolboxId(repository: string): string {
  const normalized = `gh-${repository}`
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .slice(0, 120)
  if (!normalized) throw new Error(`Could not derive Toolbox id from ${repository}.`)
  return normalized
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}
