import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFile, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  checkRtkRuntime,
  isSupportedArchitecture,
  isSupportedNodeVersion,
} from "../scripts/preflight.js"
import { tempDir } from "./helpers/temp.js"

test("requires Node.js 22.18.0 or newer", () => {
  assert.equal(isSupportedNodeVersion("22.17.9"), false)
  assert.equal(isSupportedNodeVersion("22.18.0"), true)
  assert.equal(isSupportedNodeVersion("23.0.0"), true)
})

test("supports arm64 and x64 hosts", () => {
  assert.equal(isSupportedArchitecture("arm64"), true)
  assert.equal(isSupportedArchitecture("x64"), true)
  assert.equal(isSupportedArchitecture("ia32"), false)
})

test("requires RTK only when shell.rtk is enabled", () => {
  assert.equal(checkRtkRuntime(false, undefined), undefined)
  const missingRtk = checkRtkRuntime(true, undefined)
  assert.ok(missingRtk)
  assert.match(missingRtk, /brew install rtk/u)
})

test("preflight and full setup require a configured OpenAI tunnel-client profile", async (t) => {
  const root = await realpath(await tempDir(t, "openchatx-tunnel-setup-"))
  for (const dir of ["scripts", "src", ".openchatx", "bin", "skills/create-skill"])
    await mkdir(join(root, dir), { recursive: true })
  for (const path of [
    "scripts/setup.ts",
    "scripts/setup-console.ts",
    "scripts/preflight.ts",
    "scripts/state-setup.ts",
    "src/config.ts",
    "src/host-platform.ts",
    "src/public-config.cts",
    "skills/create-skill/SKILL.md",
  ]) {
    await copyFile(new URL(`../${path}`, import.meta.url), join(root, path))
  }
  await symlink(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
    join(root, "node_modules")
  )
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", version: "0.0.0" }))
  await writeFile(
    join(root, "bin/npm"),
    `#!${process.execPath}\nconsole.log("fixture build complete")\n`,
    { mode: 0o755 }
  )
  await writeFile(
    join(root, "bin/tunnel-client"),
    `#!${process.execPath}
const args = process.argv.slice(2)
if (args[0] === "profiles" && args[1] === "list") {
  console.log(JSON.stringify([{ name: "openchatx" }]))
}
`,
    { mode: 0o755 }
  )

  const configPath = join(root, ".openchatx/config.toml")
  const source = [
    `state_dir = ${JSON.stringify(join(root, "state"))}`,
    "[tunnel]",
    'profile = "openchatx"',
    "health_port = 8080",
  ].join("\n")
  await writeFile(configPath, source)

  for (const script of ["preflight", "setup"]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(root, `scripts/${script}.ts`)],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: join(root, "bin"),
          CONTROL_PLANE_API_KEY: "test-key",
        },
        timeout: 15_000,
      }
    )
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    if (script === "preflight") assert.match(result.stdout, /Preflight passed/u)
  }

  assert.equal(await readFile(configPath, "utf8"), source)
  assert.match(
    await readFile(join(root, "state/AGENTS.md"), "utf8"),
    /OpenChatX Agent Instructions/u
  )

  const missingClient = spawnSync(
    process.execPath,
    ["--import", "tsx", join(root, "scripts/preflight.ts")],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: "", CONTROL_PLANE_API_KEY: "test-key" },
      timeout: 10_000,
    }
  )
  assert.equal(missingClient.status, 1)
  assert.match(missingClient.stderr, /tunnel-client is not installed/u)
})
