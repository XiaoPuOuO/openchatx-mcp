import { randomUUID } from "node:crypto"
import { cp, rename, rm } from "node:fs/promises"

/** Preserve the previous bundle so a running app is not deleted during installation. */
export async function installDesktopBundle(
  source: string,
  destination: string
): Promise<string | undefined> {
  const suffix = randomUUID()
  const staged = `${destination}.staged-${suffix}`
  const backup = `${destination}.previous-${suffix}`
  let preserved = false
  try {
    await cp(source, staged, { recursive: true })
    try {
      await rename(destination, backup)
      preserved = true
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
    try {
      await rename(staged, destination)
    } catch (error) {
      if (preserved) await rename(backup, destination)
      throw error
    }
    return preserved ? backup : undefined
  } finally {
    await rm(staged, { recursive: true, force: true })
  }
}
