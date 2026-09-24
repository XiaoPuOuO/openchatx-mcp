import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { runInNewContext } from "node:vm"
import { initializeOpenChatXConfig } from "../scripts/state-setup.js"
import { DEFAULT_PUBLIC_CONFIG, loadPublicConfig } from "../src/public-config.cjs"
import { tempDir } from "./helpers/temp.js"

test("loads and validates OpenChatX TOML config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-config-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "config.toml")
  await writeFile(
    path,
    [
      'state_dir = "~/.openchatx-test"',
      "",
      "[shell]",
      'path = "/bin/zsh"',
      "rtk = false",
      "",
      "[tunnel]",
      'profile = "personal"',
      "health_port = 8181",
      "",
      "[mcp]",
      'tool_output = "structured"',
      "",
      "[tools]",
      "shell = true",
      "apply_patch = true",
      "file_read = false",
      "file_write = true",
      "web = true",
      "skills = true",
      "image = true",
    ].join("\n")
  )

  assert.deepEqual(loadPublicConfig(path), {
    state_dir: "~/.openchatx-test",
    port: 3333,
    shell: { path: "/bin/zsh", rtk: false },
    tunnel: { profile: "personal", health_port: 8181 },
    mcp: { tool_output: "structured" },
    tools: {
      shell: true,
      apply_patch: true,
      file_read: false,
      file_write: true,
      web: true,
      skills: true,
      image: true,
    },
  })
})

test("loads older partial configs with defaults and preserves valid overrides", async (t) => {
  const root = await tempDir(t, "openchatx-config-partial-")
  const path = join(root, "config.toml")
  const warning = t.mock.method(console, "warn", () => undefined)
  assert.throws(() => loadPublicConfig(path), /Run `npm run setup` first/u)

  const source = "[tools]\nweb = false\n"
  await writeFile(path, source)
  const loaded = loadPublicConfig(path)
  assert.deepEqual(loaded.tunnel, DEFAULT_PUBLIC_CONFIG.tunnel)
  assert.deepEqual(loaded.tools, { ...DEFAULT_PUBLIC_CONFIG.tools, web: false })
  assert.equal(warning.mock.callCount(), 0)
  assert.equal(await readFile(path, "utf8"), source)
})

test("warns for invalid or unknown settings without discarding valid siblings", async (t) => {
  const root = await tempDir(t, "openchatx-config-invalid-")
  const path = join(root, "config.toml")
  const warning = t.mock.method(console, "warn", () => undefined)
  const source = [
    'obsolete = "unused"',
    "[shell]",
    'path = "/bin/bash"',
    'rtk = "false"',
    "[tunnel]",
    'profile = "   "',
    "health_port = 70000",
    "[mcp]",
    'tool_output = "verbose"',
    "[tools]",
    "clones = false",
  ].join("\n")
  await writeFile(path, source)
  const config = loadPublicConfig(path)
  assert.deepEqual(config.shell, { path: "/bin/bash", rtk: false })
  assert.deepEqual(config.tunnel, DEFAULT_PUBLIC_CONFIG.tunnel)
  assert.equal(config.mcp.tool_output, "compact")
  assert.equal("clones" in config.tools, false)
  const messages = warning.mock.calls.map((call) => call.arguments.join(" ")).join("\n")
  for (const key of [
    "obsolete",
    "shell.rtk",
    "tunnel.profile",
    "tunnel.health_port",
    "mcp.tool_output",
    "tools.clones",
  ]) {
    assert.ok(messages.includes(key), messages)
  }
})

test("accepts equivalent TOML formatting and leaves it untouched during setup", async (t) => {
  const root = await tempDir(t, "openchatx-config-format-")
  const { configPath } = await initializeOpenChatXConfig(root)
  const warning = t.mock.method(console, "warn", () => undefined)
  const sources = [
    "# table form\n[tools]\nweb = false\n",
    "# dotted keys with CRLF\r\ntools.web=false\r\n",
    '"tools" = { "web" = false }\n',
  ]
  for (const source of sources) {
    await writeFile(configPath, source)
    const config = loadPublicConfig(configPath)
    assert.equal(config.tools.web, false)
    assert.equal((await initializeOpenChatXConfig(root)).updated, false)
    assert.equal(await readFile(configPath, "utf8"), source)
  }
  assert.equal(warning.mock.callCount(), 0)
})

test("MCP and tunnel health ports accept overrides and default invalid values independently", async (t) => {
  const root = await tempDir(t, "openchatx-config-ports-")
  const { configPath } = await initializeOpenChatXConfig(root)
  const scaffold = await readFile(configPath, "utf8")
  assert.match(scaffold, /^port = 3333$/mu)
  assert.match(scaffold, /^health_port = 8080$/mu)

  await writeFile(configPath, 'port = 3334\n[tunnel]\nprofile = "custom"\nhealth_port = 8181\n')
  assert.equal(loadPublicConfig(configPath).port, 3334)
  assert.deepEqual(loadPublicConfig(configPath).tunnel, { profile: "custom", health_port: 8181 })

  const warning = t.mock.method(console, "warn", () => undefined)
  for (const invalid of ["0", "65536", "1.5", '"3334"']) {
    await writeFile(configPath, `port = ${invalid}\n[tunnel]\nhealth_port = ${invalid}\n`)
    const config = loadPublicConfig(configPath)
    assert.equal(config.port, 3333)
    assert.equal(config.tunnel.health_port, 8080)
  }
  assert.equal(warning.mock.callCount(), 8)
})

test("reports broken TOML syntax without rewriting the file", async (t) => {
  const root = await tempDir(t, "openchatx-config-syntax-")
  const { configPath } = await initializeOpenChatXConfig(root)
  for (const source of ["[tools\nweb = false\n", "[tools]\nweb = false\nweb = true\n"]) {
    await writeFile(configPath, source)
    assert.throws(
      () => loadPublicConfig(configPath),
      /Invalid openchatx-mcp config syntax.*\n\d+:.*\^/su
    )
    assert.equal((await initializeOpenChatXConfig(root)).updated, false)
    assert.equal(await readFile(configPath, "utf8"), source)
  }
})

test("PM2 uses normalized tunnel-client settings from the shared loader", async (t) => {
  const root = await tempDir(t, "openchatx-config-pm2-")
  const { configPath } = await initializeOpenChatXConfig(root)
  await writeFile(configPath, 'port = 3334\n[tunnel]\nprofile = "personal"\nhealth_port = 8181\n')
  const source = await readFile(new URL("../ecosystem.config.cjs", import.meta.url), "utf8")
  const nodeRequire = createRequire(import.meta.url)
  const module = { exports: {} as { apps: Array<{ name: string; args: string[] }> } }
  runInNewContext(source, {
    __dirname: root,
    module,
    require(name: string) {
      if (name === "./dist/public-config.cjs") return { loadPublicConfig }
      if (name === "node:child_process") return { execFileSync: () => "/fake/tunnel-client\n" }
      return nodeRequire(name)
    },
  })
  const tunnel = module.exports.apps.find((app) => app.name === "openchatx-tunnel")!
  assert.deepEqual(Array.from(tunnel.args), [
    "run",
    "--profile",
    "personal",
    "--health.listen-addr",
    "127.0.0.1:8181",
  ])
})
