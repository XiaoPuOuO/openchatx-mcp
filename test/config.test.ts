import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { runInNewContext } from "node:vm"
import { initializeShellbyConfig } from "../scripts/workspace-setup.js"
import { DEFAULT_PUBLIC_CONFIG, loadPublicConfig } from "../src/public-config.cjs"
import { tempDir } from "./helpers/temp.js"

test("loads and validates Shellby TOML config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-config-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "config.toml")
  await writeFile(
    path,
    [
      'state_dir = "~/.shellby-test"',
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
      "file_read = false",
      "file_write = true",
      "clones = true",
      "computer = false",
      "subagents = false",
      "web = true",
      "skills = true",
      "image = true",
    ].join("\n")
  )

  assert.deepEqual(loadPublicConfig(path), {
    state_dir: "~/.shellby-test",
    port: 3333,
    workspace: "~/Work",
    shell: { path: "/bin/zsh", rtk: false },
    chatgpt: {
      cdp_endpoint: "http://127.0.0.1:9222",
      project_url: "https://chatgpt.com/",
      max_delegated_agents: 5,
    },
    ngrok: {
      enabled: true,
      api_port: 4040,
      url: "https://shellby.ngrok.app",
      pooling_enabled: true,
    },
    mcp: { tool_output: "structured" },
    ui: { enabled: true },
    tools: {
      review: true,
      shell: true,
      apply_patch: true,
      file_read: false,
      file_write: true,
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
      "file_read = true",
      "file_write = false",
      "clones = true",
      "computer = false",
      "subagents = false",
      "web = true",
      "skills = true",
      "image = true",
    ].join("\n")
  )

  const loaded = loadPublicConfig(path)
  assert.equal(loaded.state_dir, "~/.shellby")
  assert.equal(loaded.workspace, "~/Work")
  assert.equal(loaded.chatgpt.cdp_endpoint, "http://127.0.0.1:9222")
  assert.equal(loaded.chatgpt.project_url, "https://chatgpt.com/")
})

test("loads older partial configs with silent defaults and preserves valid overrides", async (t) => {
  const root = await tempDir(t, "shellby-config-partial-")
  const path = join(root, "config.toml")
  const warning = t.mock.method(console, "warn", () => undefined)
  assert.throws(() => loadPublicConfig(path), /Run `npm run setup` first/u)

  const source = 'workspace = "~/Work"\n[tools]\ncomputer = false\nclones = false\n'
  await writeFile(path, source)
  const loaded = loadPublicConfig(path)
  assert.equal(loaded.workspace, "~/Work")
  assert.deepEqual(loaded.chatgpt, DEFAULT_PUBLIC_CONFIG.chatgpt)
  assert.deepEqual(loaded.tools, { ...DEFAULT_PUBLIC_CONFIG.tools, computer: false, clones: false })
  assert.equal(warning.mock.callCount(), 0)
  assert.equal(await readFile(path, "utf8"), source)

  await writeFile(path, "# defaults only\n")
  assert.deepEqual(loadPublicConfig(path), DEFAULT_PUBLIC_CONFIG)
})

test("warns for invalid or unknown settings without discarding valid siblings", async (t) => {
  const root = await tempDir(t, "shellby-config-invalid-")
  const path = join(root, "config.toml")
  const warning = t.mock.method(console, "warn", () => undefined)
  const source = [
    'workspace = "   "',
    'obsolete = "unused"',
    "[shell]",
    'path = "/bin/bash"',
    'rtk = "false"',
    "[chatgpt]",
    'cdp_endpoint = "http://127.0.0.1"',
    'project_url = "https://chatgpt.com/g/custom/project"',
    "max_delegated_agents = 0",
    "[mcp]",
    'tool_output = "verbose"',
    "[tools]",
    "computer = false",
    "clones = false",
    "comptuer = true",
  ].join("\n")
  await writeFile(path, source)
  const config = loadPublicConfig(path)
  assert.equal(config.workspace, DEFAULT_PUBLIC_CONFIG.workspace)
  assert.deepEqual(config.shell, { path: "/bin/bash", rtk: false })
  assert.deepEqual(config.chatgpt, {
    ...DEFAULT_PUBLIC_CONFIG.chatgpt,
    project_url: "https://chatgpt.com/g/custom/project",
  })
  assert.equal(config.mcp.tool_output, "compact")
  assert.equal(config.tools.computer, false)
  assert.equal(config.tools.clones, false)
  assert.equal("comptuer" in config.tools, false)
  assert.equal("obsolete" in config, false)
  const messages = warning.mock.calls.map((call) => call.arguments.join(" ")).join("\n")
  for (const key of [
    "workspace",
    "obsolete",
    "shell.rtk",
    "chatgpt.cdp_endpoint",
    "chatgpt.max_delegated_agents",
    "mcp.tool_output",
    "tools.comptuer",
  ]) {
    assert.ok(messages.includes(key), messages)
  }
  assert.equal(warning.mock.callCount(), 7)
  assert.equal(await readFile(path, "utf8"), source)
})

test("defaults malformed sections and normalizes invalid ngrok combinations", async (t) => {
  const root = await tempDir(t, "shellby-config-sections-")
  const path = join(root, "config.toml")
  const warning = t.mock.method(console, "warn", () => undefined)
  await writeFile(path, "tools = false\nui = []\n[shell]\nrtk = true\n")
  const loaded = loadPublicConfig(path)
  assert.deepEqual(loaded.tools, DEFAULT_PUBLIC_CONFIG.tools)
  assert.deepEqual(loaded.ui, DEFAULT_PUBLIC_CONFIG.ui)
  assert.equal(loaded.shell.rtk, true)
  assert.equal(warning.mock.callCount(), 2)

  for (const source of [
    "[ngrok]\npooling_enabled = true",
    '[ngrok]\nurl = "file:///tmp/tunnel"\npooling_enabled = true',
  ]) {
    await writeFile(path, source)
    assert.deepEqual(loadPublicConfig(path).ngrok, {
      enabled: true,
      api_port: 4040,
      pooling_enabled: false,
    })
  }
  await writeFile(path, '[ngrok]\nurl = "https://custom.ngrok.app"\npooling_enabled = "true"')
  assert.deepEqual(loadPublicConfig(path).ngrok, {
    enabled: true,
    api_port: 4040,
    url: "https://custom.ngrok.app",
    pooling_enabled: false,
  })
})

test("falls back for invalid delegated limits and retains positive integers", async (t) => {
  const root = await tempDir(t, "shellby-config-agent-limit-")
  const path = join(root, "config.toml")
  const warning = t.mock.method(console, "warn", () => undefined)
  for (const invalid of ["0", "-1", "1.5", '"3"', "true", "inf", "nan"]) {
    await writeFile(path, `[chatgpt]\nmax_delegated_agents = ${invalid}`)
    assert.equal(loadPublicConfig(path).chatgpt.max_delegated_agents, 3)
  }
  assert.equal(warning.mock.callCount(), 7)
  for (const limit of [1, 5]) {
    await writeFile(path, `[chatgpt]\nmax_delegated_agents = ${limit}`)
    assert.equal(loadPublicConfig(path).chatgpt.max_delegated_agents, limit)
  }
  assert.equal(warning.mock.callCount(), 7)
})

test("accepts equivalent TOML formatting and leaves it untouched during setup", async (t) => {
  const root = await tempDir(t, "shellby-config-format-")
  const { configPath } = await initializeShellbyConfig(root)
  const warning = t.mock.method(console, "warn", () => undefined)
  const sources = [
    "# table form\n[chatgpt]\nmax_delegated_agents = 5\n[tools]\ncomputer = false\n",
    "# dotted keys with CRLF\r\nchatgpt.max_delegated_agents=5\r\ntools.computer = false # inline comment\r\n",
    '"tools" = { "computer" = false }\nchatgpt = { max_delegated_agents = 5 }\n',
  ]
  for (const source of sources) {
    await writeFile(configPath, source)
    const config = loadPublicConfig(configPath)
    assert.equal(config.chatgpt.max_delegated_agents, 5)
    assert.equal(config.tools.computer, false)
    assert.equal((await initializeShellbyConfig(root)).updated, false)
    assert.equal(await readFile(configPath, "utf8"), source)
  }
  assert.equal(warning.mock.callCount(), 0)
})

test("MCP and ngrok API ports accept overrides and default invalid values individually", async (t) => {
  const root = await tempDir(t, "shellby-config-ports-")
  const { configPath } = await initializeShellbyConfig(root)
  const scaffold = await readFile(configPath, "utf8")
  assert.match(scaffold, /^port = 3333$/mu)
  assert.match(scaffold, /^api_port = 4040$/mu)
  await writeFile(configPath, "port = 3334\n[ngrok]\napi_port = 4041\n")
  assert.equal(loadPublicConfig(configPath).port, 3334)
  assert.equal(loadPublicConfig(configPath).ngrok.api_port, 4041)
  const warning = t.mock.method(console, "warn", () => undefined)
  for (const invalid of ["0", "65536", "1.5", '"3334"']) {
    await writeFile(
      configPath,
      `port = ${invalid}\n[ngrok]\napi_port = ${invalid}\nurl = "https://custom.ngrok.app"`
    )
    const config = loadPublicConfig(configPath)
    assert.equal(config.port, 3333)
    assert.equal(config.ngrok.api_port, 4040)
    assert.equal(config.ngrok.url, "https://custom.ngrok.app")
  }
  assert.equal(warning.mock.callCount(), 8)
})

test("reports broken TOML syntax without rewriting the file or silently replacing the whole config", async (t) => {
  const root = await tempDir(t, "shellby-config-syntax-")
  const { configPath } = await initializeShellbyConfig(root)
  for (const source of [
    "[tools\ncomputer = false\n",
    "[tools]\ncomputer = false\ncomputer = true\n",
  ]) {
    await writeFile(configPath, source)
    assert.throws(() => loadPublicConfig(configPath), /Invalid Shellby config syntax.*\n\d+:.*\^/su)
    assert.equal((await initializeShellbyConfig(root)).updated, false)
    assert.equal(await readFile(configPath, "utf8"), source)
  }
})

test("PM2 uses normalized ngrok settings from the shared loader", async (t) => {
  const root = await tempDir(t, "shellby-config-pm2-")
  const { configPath } = await initializeShellbyConfig(root)
  t.mock.method(console, "warn", () => undefined)
  await writeFile(
    configPath,
    'port = 3334\n[ngrok]\napi_port = 4041\nurl = "https://custom.ngrok.app"\npooling_enabled = "false"'
  )
  const source = await readFile(new URL("../ecosystem.config.cjs", import.meta.url), "utf8")
  const nodeRequire = createRequire(import.meta.url)
  const module = { exports: {} as { apps: Array<{ name: string; args: string[] }> } }
  runInNewContext(source, {
    __dirname: root,
    module,
    require(name: string) {
      if (name === "./dist/public-config.cjs") return { loadPublicConfig }
      if (name === "./scripts/ngrok-config.cjs")
        return { ngrokConfigFiles: () => ["/fake/native.yml", "/fake/override.json"] }
      if (name === "node:child_process") return { execFileSync: () => "/fake/ngrok" }
      return nodeRequire(name)
    },
  })
  const ngrok = module.exports.apps.find((app) => app.name === "shellby-ngrok")!
  assert.ok(ngrok.args.includes("https://custom.ngrok.app"))
  assert.ok(ngrok.args.includes("http://127.0.0.1:3334"))
  assert.ok(ngrok.args.includes("/fake/override.json"))
  assert.equal(ngrok.args.includes("--pooling-enabled"), false)
})

test("ngrok enablement defaults on, accepts false, and preserves reserved settings", async (t) => {
  const root = await tempDir(t, "shellby-config-local-")
  const { configPath } = await initializeShellbyConfig(root)
  assert.match(await readFile(configPath, "utf8"), /^enabled = true$/mu)
  assert.equal(loadPublicConfig(configPath).ngrok.enabled, true)
  const source =
    '[ngrok]\nenabled = false\nurl = "https://custom.ngrok.app"\npooling_enabled = true\n'
  await writeFile(configPath, source)
  assert.deepEqual(loadPublicConfig(configPath).ngrok, {
    enabled: false,
    api_port: 4040,
    url: "https://custom.ngrok.app",
    pooling_enabled: true,
  })
  await initializeShellbyConfig(root)
  assert.equal(await readFile(configPath, "utf8"), source)
  t.mock.method(console, "warn", () => undefined)
  await writeFile(configPath, '[ngrok]\nenabled = "false"')
  assert.equal(loadPublicConfig(configPath).ngrok.enabled, true)
})

test("local PM2 ecosystem needs neither ngrok executable nor native configuration", async (t) => {
  const root = await tempDir(t, "shellby-config-local-pm2-")
  const { configPath } = await initializeShellbyConfig(root)
  await writeFile(configPath, "[ngrok]\nenabled = false\n")
  const source = await readFile(new URL("../ecosystem.config.cjs", import.meta.url), "utf8")
  const nodeRequire = createRequire(import.meta.url)
  const module = { exports: {} as { apps: Array<{ name: string }> } }
  const unexpectedNgrok = () => {
    throw new Error("ngrok must not be accessed when disabled")
  }
  runInNewContext(source, {
    __dirname: root,
    module,
    require(name: string) {
      if (name === "./dist/public-config.cjs") return { loadPublicConfig }
      if (name === "./scripts/ngrok-config.cjs") return { ngrokConfigFiles: unexpectedNgrok }
      if (name === "node:child_process") return { execFileSync: unexpectedNgrok }
      return nodeRequire(name)
    },
  })
  assert.equal(module.exports.apps.length, 1)
  assert.equal(module.exports.apps[0]?.name, "shellby-mcp")
})
