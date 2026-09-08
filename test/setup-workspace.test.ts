import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

// @ts-expect-error scripts are plain ESM entrypoints without declaration files.
import { initializeShellbyConfig, initializeWorkspace } from "../scripts/workspace-setup.mjs"
import { loadPublicConfig } from "../src/config.js"
import { SkillCatalog } from "../src/tools/skills.js"
import { tempDir } from "./helpers/temp.js"

test("workspace setup creates starter instructions and create-skill without overwriting either", async (t) => {
  const workspace = await tempDir(t, "mcp-setup-workspace-")

  const initial = await initializeWorkspace(workspace)
  assert.equal(initial.created, true)
  assert.equal(initial.starterSkillCreated, true)
  const agentsPath = join(workspace, "AGENTS.md")
  assert.match(await readFile(agentsPath, "utf8"), /# Workspace Instructions/)
  const skillPath = join(workspace, "skills", "create-skill", "SKILL.md")
  assert.match(await readFile(skillPath, "utf8"), /name: create-skill/)

  const catalog = new SkillCatalog(join(workspace, "skills"))
  assert.deepEqual(
    (await catalog.list()).map(({ name }) => name),
    ["create-skill"]
  )

  await writeFile(agentsPath, "# My Instructions\n", "utf8")
  await writeFile(skillPath, "---\nname: create-skill\ndescription: My custom skill.\n---\n", "utf8")
  const repeated = await initializeWorkspace(workspace)
  assert.equal(repeated.created, false)
  assert.equal(repeated.starterSkillCreated, false)
  assert.equal(await readFile(agentsPath, "utf8"), "# My Instructions\n")
  assert.match(await readFile(skillPath, "utf8"), /My custom skill/)
})

test("setup creates a complete active Shellby config and fills missing fields without replacing user values", async (t) => {
  const root = await tempDir(t, "shellby-config-scaffold-")

  const initial = await initializeShellbyConfig(root)
  assert.equal(initial.created, true)
  assert.equal(initial.updated, false)
  assert.equal(initial.configPath, join(root, ".shellby", "config.toml"))
  const scaffold = loadPublicConfig(initial.configPath)
  assert.equal(scaffold.workspace, "~/Desktop/agent-workspace")
  assert.deepEqual(scaffold.shell, { path: "/bin/zsh", rtk: false })
  assert.deepEqual(scaffold.chatgpt, {
    cdp_endpoint: "http://127.0.0.1:9222",
    project_url: "https://chatgpt.com/",
  })
  assert.deepEqual(scaffold.mcp, { tool_output: "compact" })
  assert.deepEqual(scaffold.ui, { enabled: false })
  assert.equal(scaffold.tools.computer, true)

  await writeFile(initial.configPath, 'workspace = "~/Custom"\n\n[tools]\ncomputer = false\n')
  const repeated = await initializeShellbyConfig(root)
  assert.equal(repeated.created, false)
  assert.equal(repeated.updated, true)
  const migrated = loadPublicConfig(initial.configPath)
  assert.equal(migrated.workspace, "~/Custom")
  assert.equal(migrated.tools.computer, false)
  assert.equal(migrated.tools.shell, true)
  assert.equal(migrated.shell.rtk, false)
  assert.equal(migrated.chatgpt.project_url, "https://chatgpt.com/")
  assert.equal(migrated.mcp.tool_output, "compact")
  assert.equal(migrated.ui.enabled, false)

  const complete = await initializeShellbyConfig(root)
  assert.equal(complete.created, false)
  assert.equal(complete.updated, false)
})
