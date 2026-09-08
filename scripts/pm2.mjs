import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))

// The local package still defaults to the shared ~/.pm2 daemon unless every command sets PM2_HOME.
const result = spawnSync(process.execPath, [join(repoRoot, "node_modules", ".bin", "pm2"), ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: { ...process.env, PM2_HOME: join(homedir(), ".shellby", "pm2") },
  stdio: "inherit",
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
