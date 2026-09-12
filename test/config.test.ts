import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// @ts-expect-error scripts are plain ESM entrypoints without declaration files.
import { initializeShellbyConfig } from "../scripts/workspace-setup.mjs"
import { loadPublicConfig } from "../src/config.js"

test("loads and validates Shellby TOML config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-config-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "config.toml")
  await writeFile(
    path,
    [
      'workspace = "~/Work"',
      "",
      "[shell]",
      'path = "/bin/zsh"',
      "rtk = false",
      "",
      "[chatgpt]",
      'cdp_endpoint = "http://127.0.0.1:9222"',
      'project_url = "https://chatgpt.com/"',
      "max_delegated_agents = 5",
      "",
      "[ngrok]",
      'url = "https://shellby.ngrok.app"',
      "pooling_enabled = true",
      "",
      "[mcp]",
      'tool_output = "structured"',
      "",
      "[ui]",
      "enabled = true",
      "",
      "[tools]",
      "review = true",
      "shell = true",
      "apply_patch = true",
      "clones = true",
      "computer = false",
      "subagents = false",
      "web = true",
      "skills = true",
      "image = true",
    ].join("\n")
  )

  assert.deepEqual(loadPublicConfig(path), {
    workspace: "~/Work",
    shell: { path: "/bin/zsh", rtk: false },
    chatgpt: { cdp_endpoint: "http://127.0.0.1:9222", project_url: "https://chatgpt.com/", max_delegated_agents: 5 },
    ngrok: { url: "https://shellby.ngrok.app", pooling_enabled: true },
    mcp: { tool_output: "structured" },
    ui: { enabled: true },
    tools: {
      review: true,
      shell: true,
      apply_patch: true,
      clones: true,
      computer: false,
      subagents: false,
      web: true,
      skills: true,
      image: true,
    },
  })
})

test("ignores TOML comments and defaults omitted chatgpt.project_url", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-config-comments-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "config.toml")
  await writeFile(
    path,
    [
      "# Shellby configuration.",
      'workspace = "~/Work"  # expanded at runtime',
      "",
      "[shell]",
      'path = "/bin/zsh"',
      "rtk = false",
      "",
      "[chatgpt]",
      'cdp_endpoint = "http://127.0.0.1:9222"',
      '# project_url = "https://chatgpt.com/g/example/project"',
      "max_delegated_agents = 3",
      "",
      "[mcp]",
      'tool_output = "compact"',
      "",
      "[ui]",
      "enabled = true",
      "",
      "[tools]",
      "review = true",
      "shell = true",
      "apply_patch = true",
      "clones = true",
      "computer = false",
      "subagents = false",
      "web = true",
      "skills = true",
      "image = true",
    ].join("\n")
  )

  const loaded = loadPublicConfig(path)
  assert.equal(loaded.workspace, "~/Work")
  assert.equal(loaded.chatgpt.cdp_endpoint, "http://127.0.0.1:9222")
  assert.equal(loaded.chatgpt.project_url, "https://chatgpt.com")
})

test("requires the active config file and every public config field", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-config-required-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "config.toml")

  assert.throws(() => loadPublicConfig(path), /Run `npm run setup` first/)

  await writeFile(path, 'workspace = "~/Work"\n')
  assert.throws(() => loadPublicConfig(path), /shell|chatgpt|tools/s)
})

test("rejects malformed TOML and unknown public config keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-config-invalid-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "config.toml")
  await writeFile(path, "[tools\ncomputer = false\n")

  assert.throws(() => loadPublicConfig(path), /Invalid Shellby config/)

  await writeFile(path, "[tools]\ncomptuer = false\n")
  assert.throws(() => loadPublicConfig(path), /Unrecognized key.*comptuer/s)

  await writeFile(path, 'workspace = "   "\n')
  assert.throws(() => loadPublicConfig(path), /Too small/)

  await writeFile(path, '[chatgpt]\ncdp_endpoint = "file:///tmp/chrome"\n')
  assert.throws(() => loadPublicConfig(path), /URL must use http or https/)

  await writeFile(
    path,
    [
      'workspace = "~/Work"',
      "[shell]",
      'path = "/bin/zsh"',
      "rtk = true",
      "[chatgpt]",
      'cdp_endpoint = "http://127.0.0.1"',
      'project_url = "https://chatgpt.com/"',
      "max_delegated_agents = 5",
      "[mcp]",
      'tool_output = "compact"',
      "[ui]",
      "enabled = true",
      "[tools]",
      "review = true",
      "shell = true",
      "apply_patch = true",
      "clones = true",
      "subagents = true",
      "web = true",
      "skills = true",
      "image = true",
      "computer = true",
    ].join("\n")
  )
  assert.throws(() => loadPublicConfig(path), /Local CDP endpoint must include an explicit port/)

  await writeFile(
    path,
    [
      'workspace = "~/Work"',
      "[shell]",
      'path = "/bin/zsh"',
      "rtk = true",
      "[chatgpt]",
      'cdp_endpoint = "http://127.0.0.1:9222"',
      'project_url = "https://chatgpt.com/"',
      "max_delegated_agents = 5",
      "[mcp]",
      'tool_output = "verbose"',
      "[ui]",
      "enabled = true",
      "[tools]",
      "review = true",
      "shell = true",
      "apply_patch = true",
      "clones = true",
      "subagents = true",
      "web = true",
      "skills = true",
      "image = true",
      "computer = true",
    ].join("\n")
  )
  assert.throws(() => loadPublicConfig(path), /compact|structured/)
})

test("requires a positive integer delegated-agent limit and preserves configured limits during setup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-config-agent-limit-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { configPath } = await initializeShellbyConfig(root)
  const template = await readFile(configPath, "utf8")

  for (const invalid of ["0", "-1", "1.5", '"3"', "true", "inf", "nan"]) {
    await writeFile(configPath, template.replace("max_delegated_agents = 3", `max_delegated_agents = ${invalid}`))
    assert.throws(() => loadPublicConfig(configPath), /max_delegated_agents/)
  }

  await writeFile(configPath, template.replace("max_delegated_agents = 3", ""))
  assert.throws(() => loadPublicConfig(configPath), /max_delegated_agents/)
  assert.equal((await initializeShellbyConfig(root)).updated, true)
  assert.equal(loadPublicConfig(configPath).chatgpt.max_delegated_agents, 3)

  for (const limit of [1, 5]) {
    await writeFile(configPath, template.replace("max_delegated_agents = 3", `max_delegated_agents = ${limit}`).replace("rtk = false", ""))
    assert.equal((await initializeShellbyConfig(root)).updated, true)
    assert.equal(loadPublicConfig(configPath).chatgpt.max_delegated_agents, limit)
  }
})
