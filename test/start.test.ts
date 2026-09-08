import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import test, { type TestContext } from "node:test"

import { tempDir } from "./helpers/temp.js"

// Run the real entrypoint in a disposable repository with fake external commands, never the live PM2 daemon.
async function runStartup(t: TestContext, restart: boolean, failCommand = "", pm2Args?: string[]) {
  const root = await realpath(await tempDir(t, "shellby-start-"))
  for (const directory of ["scripts", "src", "bin", "node_modules/.bin"]) await mkdir(join(root, directory), { recursive: true })
  await copyFile(new URL("../scripts/start.mjs", import.meta.url), join(root, "scripts", "start.mjs"))
  await copyFile(new URL("../scripts/pm2.mjs", import.meta.url), join(root, "scripts", "pm2.mjs"))
  await writeFile(
    join(root, "src", "config.ts"),
    `export const MCP_CONFIG = ${JSON.stringify({ workspace: root, shell: { rtk: false }, tools: { clones: false, subagents: false } })}`
  )
  await writeFile(
    join(root, "scripts", "preflight.mjs"),
    `export async function checkPublicRuntime() { return { errors: [] }; }
export function checkRtkRuntime() {}
export function printPreflightErrors() {}`
  )
  await writeFile(join(root, "scripts", "print-url.mjs"), 'console.log("https://test.invalid/mcp")')
  await writeFile(join(root, "agent-commands.yaml"), "previous audit\n")

  for (const command of ["npm", "pm2"]) {
    await writeFile(
      join(root, command === "pm2" ? "node_modules/.bin" : "bin", command),
      `#!/usr/bin/env node
const { appendFileSync, existsSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "calls.jsonl"))}, JSON.stringify({
  command: ${JSON.stringify(command)}, args, auditExists: existsSync(${JSON.stringify(join(root, "agent-commands.yaml"))}),
  pm2Home: process.env.PM2_HOME, cwd: process.cwd()
}) + "\\n");
if (${JSON.stringify(command)} + " " + args[0] === process.env.START_TEST_FAIL) process.exit(7);
`,
      { mode: 0o755 }
    )
  }

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "data:text/javascript,globalThis.fetch=async()=>({ok:true})",
      join(root, "scripts", pm2Args ? "pm2.mjs" : "start.mjs"),
      ...(pm2Args ?? (restart ? ["--restart"] : [])),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
        START_TEST_FAIL: failCommand,
        PM2_HOME: join(root, "unrelated-pm2"),
      },
      encoding: "utf8",
      timeout: 15_000,
    }
  )
  assert.ifError(result.error)
  const calls = (await readFile(join(root, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const { pm2Home, cwd, ...call } = JSON.parse(line) as {
        command: string
        args: string[]
        auditExists: boolean
        pm2Home: string
        cwd: string
      }
      if (call.command === "pm2") {
        assert.equal(pm2Home, join(homedir(), ".shellby", "pm2"), "every PM2 call must override the inherited shared daemon")
        assert.equal(cwd, root, "PM2 resolves ecosystem paths from the repository")
      }
      return call
    })
  return { root, result, calls }
}

test("restart rebuilds before replacing PM2 and clears the audit only after shutdown", async (t) => {
  const { result, calls } = await runStartup(t, true)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls, [
    { command: "npm", args: ["run", "build"], auditExists: true },
    { command: "pm2", args: ["kill"], auditExists: true },
    { command: "pm2", args: ["startOrReload", "ecosystem.config.cjs", "--update-env"], auditExists: false },
  ])
  assert.match(result.stdout, /https:\/\/test.invalid\/mcp/)
})

test("ordinary startup keeps the PM2 daemon and audit log", async (t) => {
  const { result, calls } = await runStartup(t, false)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls, [
    { command: "npm", args: ["run", "build"], auditExists: true },
    { command: "pm2", args: ["delete", "shellby-cursor-host"], auditExists: true },
    { command: "pm2", args: ["startOrReload", "ecosystem.config.cjs", "--update-env"], auditExists: true },
  ])
})

for (const failure of ["npm run", "pm2 kill"]) {
  test(`restart stops after ${failure} fails and preserves the audit log`, async (t) => {
    const { root, result, calls } = await runStartup(t, true, failure)
    assert.equal(result.status, 7)
    assert.equal(calls.length, failure === "npm run" ? 1 : 2)
    assert.equal(await readFile(join(root, "agent-commands.yaml"), "utf8"), "previous audit\n")
  })
}

test("PM2 operational commands use Shellby's dedicated daemon and preserve CLI arguments", async (t) => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }
  for (const name of ["stop", "status", "logs", "pm2"]) {
    const command = packageJson.scripts[name]!
    assert.ok(command.startsWith("node scripts/pm2.mjs"))
    const args = command.split(" ").slice(2)
    if (name === "pm2") args.push("jlist")
    if (name === "logs") args.push("--lines", "20", "--nostream")
    const { result, calls } = await runStartup(t, false, "", args)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls, [{ command: "pm2", args, auditExists: true }])
  }
})
