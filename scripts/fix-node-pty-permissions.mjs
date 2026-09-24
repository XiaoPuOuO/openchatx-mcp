#!/usr/bin/env node

import { chmod, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

if (process.platform !== "darwin") process.exit(0)

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const prebuilds = join(repoRoot, "node_modules", "node-pty", "prebuilds")

let entries
try {
  entries = await readdir(prebuilds, { withFileTypes: true })
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") process.exit(0)
  throw error
}

for (const entry of entries) {
  if (!entry.isDirectory() || !entry.name.startsWith("darwin-")) continue
  const helper = join(prebuilds, entry.name, "spawn-helper")
  try {
    await chmod(helper, 0o755)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
}
