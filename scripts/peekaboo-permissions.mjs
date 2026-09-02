import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const optional = process.argv.includes("--optional")
const statusOnly = process.argv.includes("--status")
const executable = fileURLToPath(new URL("../vendor/peekaboo/peekaboo", import.meta.url))
const args = statusOnly ? ["permissions", "status", "--all-sources"] : ["permissions", "grant"]
const result = spawnSync(executable, args, { stdio: "inherit" })

if (result.error?.code === "ENOENT") {
  const message = "The bundled Peekaboo executable is missing. Run `npm install`, then run `npm run setup:computer`."
  if (optional) console.log(`Computer Use: ${message}`)
  else console.error(message)
  process.exit(optional ? 0 : 1)
}

if (result.error) throw result.error
if (result.status !== 0) {
  if (optional) {
    console.warn("Computer Use: Peekaboo permission status could not be read. Run `npm run setup:computer` for Peekaboo's permission guide.")
    process.exit(0)
  }
  process.exit(result.status ?? 1)
}

if (statusOnly) {
  console.log("If a required Peekaboo permission is not granted, run `npm run setup:computer`.")
}
