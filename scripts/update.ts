import { spawnSync } from "node:child_process"
import { dirname } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`)
  }
  return result.stdout.trim()
}

const status = run("git", ["status", "--porcelain"])
if (status) {
  console.error("OpenChatX update refused because the repository has local changes.")
  process.exit(1)
}

run("git", ["fetch", "origin", "main"])
const relation = run("git", ["rev-list", "--left-right", "--count", "HEAD...origin/main"])
const [aheadText, behindText] = relation.split(/\s+/u)
const ahead = Number(aheadText)
const behind = Number(behindText)
if (ahead > 0) {
  console.error("OpenChatX update refused because local main has commits not on origin/main.")
  process.exit(1)
}
if (behind === 0) {
  console.log("OpenChatX is already up to date.")
  process.exit(0)
}

run("git", ["merge", "--ff-only", "origin/main"])
run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"])
run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"])
run(process.platform === "win32" ? "npm.cmd" : "npm", ["--prefix", "ui", "ci"])
run(process.platform === "win32" ? "npm.cmd" : "npm", ["--prefix", "ui", "run", "build"])
console.log("OpenChatX updated. Run npm start to reload the managed runtime.")
