import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFile, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { tempDir } from "./helpers/temp.js"

// @ts-expect-error scripts are plain ESM entrypoints without declaration files.
import { checkRtkRuntime, isSupportedArchitecture, isSupportedNodeVersion } from "../scripts/preflight.mjs"

test("requires Node.js 22.13.0 or newer", () => {
  assert.equal(isSupportedNodeVersion("22.12.9"), false)
  assert.equal(isSupportedNodeVersion("22.13.0"), true)
  assert.equal(isSupportedNodeVersion("23.0.0"), true)
})

test("supports Apple Silicon and Intel Macs", () => {
  assert.equal(isSupportedArchitecture("arm64"), true)
  assert.equal(isSupportedArchitecture("x64"), true)
  assert.equal(isSupportedArchitecture("ia32"), false)
})

test("requires RTK only when shell.rtk is enabled", () => {
  assert.equal(checkRtkRuntime(false, undefined), undefined)
  assert.match(checkRtkRuntime(true, undefined), /brew install rtk/)
})

test("preflight and full setup honor local config without ngrok on PATH", async (t) => {
  const root = await realpath(await tempDir(t, "shellby-local-setup-"))
  for (const dir of ["scripts", "src", ".shellby", "bin", "skills/create-skill"]) await mkdir(join(root, dir), { recursive: true })
  for (const path of [
    "scripts/setup.mjs",
    "scripts/setup-ui.mjs",
    "scripts/preflight.mjs",
    "scripts/workspace-setup.mjs",
    "src/config.ts",
    "src/public-config.cts",
    "skills/create-skill/SKILL.md",
  ]) {
    await copyFile(new URL(`../${path}`, import.meta.url), join(root, path))
  }
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"))
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", version: "0.0.0" }))
  await writeFile(join(root, "bin/npm"), `#!${process.execPath}\nconsole.log("fixture build complete")\n`, { mode: 0o755 })
  const configPath = join(root, ".shellby/config.toml")
  const source = [
    `state_dir = ${JSON.stringify(join(root, "state"))}`,
    `workspace = ${JSON.stringify(join(root, "workspace"))}`,
    "[ngrok]",
    "enabled = false",
    "[tools]",
    ...["review", "shell", "apply_patch", "clones", "subagents", "web", "skills", "image", "computer"].map((name) => `${name} = false`),
  ].join("\n")
  await writeFile(configPath, source)
  for (const script of ["preflight", "setup"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", join(root, `scripts/${script}.mjs`)], {
      encoding: "utf8",
      env: { ...process.env, PATH: join(root, "bin") },
      timeout: 15_000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    if (script === "preflight") assert.match(result.stdout, /Preflight passed/)
  }
  assert.equal(await readFile(configPath, "utf8"), source)
  assert.match(await readFile(join(root, "workspace/AGENTS.md"), "utf8"), /Workspace Instructions/)
  await writeFile(configPath, source.replace("enabled = false", "enabled = true"))
  const remote = spawnSync(process.execPath, ["--import", "tsx", join(root, "scripts/preflight.mjs")], {
    encoding: "utf8",
    env: { ...process.env, PATH: join(root, "bin") },
    timeout: 10_000,
  })
  assert.equal(remote.status, 1)
  assert.match(remote.stderr, /ngrok is not installed/)
})
