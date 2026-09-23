import { spawnSync } from "node:child_process"
import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { MCP_CONFIG } from "../src/config.js"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const pm2Args: string[] = process.argv.slice(2)

// Shellby uses an installation-specific PM2 home so separate configured state roots stay isolated.
const result = spawnSync(
  process.execPath,
  [join(repoRoot, "node_modules", ".bin", "pm2"), ...pm2Args],
  {
    cwd: repoRoot,
    env: { ...process.env, PM2_HOME: join(MCP_CONFIG.stateDir, "pm2") },
    stdio: "inherit",
  }
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
