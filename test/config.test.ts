import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { runInNewContext } from "node:vm"
import { initializeOpenChatXConfig } from "../scripts/workspace-setup.js"
import { DEFAULT_PUBLIC_CONFIG, loadPublicConfig } from "../src/public-config.cjs"
import { tempDir } from "./helpers/temp.js"

test("loads and validates OpenChatX TOML config", async (t) => {
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
      "[ngrok]",
      'url = "https://shellby.ngrok.app"',
      "pooling_enabled = true",
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
    state_dir: "~/.shellby-test",
    port: 3333,
    workspace: "~/Work",
    shell: { path: "/bin/zsh", rtk: false },
    ngrok: {
      enabled: true,
      api_port: 4040,
      url: "https://shellby.ngrok.app",
      pooling_enabled: true,
    },
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

test("ignores TOML comments and preserves valid settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-config-comments-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "config.toml")
  await writeFile(
    path,
    [
      "# openchatx-mcp configuration.",
      'workspace = "~/Work"  # expanded at runtime',
      "",
      "[shell]",
      'path = "/bin/zsh"',
      "rtk = false",
      "",
      "[mcp]",
      'tool_output = "compact"',
      "",
      "[tools]",
      "shell = true",
      "apply_patch = true",
      "file_read = true",
      "file_write = false",
      "web = true",
      "skills = true",
      "image = true",
    ].join("\n")
  )

  const loaded = loadPublicConfig(path)
  assert.equal(loaded.state_dir, "~/.openchatx-mcp")
  assert.equal(loaded.workspace, "~/Work")
})

test("loads older partial configs with silent defaults and preserves valid overrides", async (t) => {
  const root = await tempDir(t, "shellby-config-partial-")
  const path = join(root, "config.toml")
  const warning = t.mock.method(console, "warn", () => undefined)
  assert.throws(() => loadPublicConfig(path), /Run `npm run setup` first/u)

  const source = 'workspace = "~/Work"\n[tools]\nweb = false\n'
  await writeFile(path, source)
  const loaded = loadPublicConfig(path)
  assert.equal(loaded.workspace, "~/Work")
  assert.deepEqual(loaded.tools, { ...DEFAULT_PUBLIC_CONFIG.tools, web: false })
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
    "[mcp]",
    'tool_output = "verbose"',
    "[tools]",
    "clones = false",
    "comptuer = true",
  ].join("\n")
  await writeFile(path, source)
  const config = loadPublicConfig(path)
  assert.equal(config.workspace, DEFAULT_PUBLIC_CONFIG.workspace)
  assert.deepEqual(config.shell, { path: "/bin/bash", rtk: false })
  assert.equal(config.mcp.tool_output, "compact")
  assert.equal("clones" in config.tools, false)
  assert.equal("comptuer" in config.tools, false)
  assert.equal("obsolete" in config, false)
  const messages = warning.mock.calls.map((call) => call.arguments.join(" ")).join("\n")
  for (const key of [
    "workspace",
    "obsolete",
    "shell.rtk",
    "mcp.tool_output",
    "tools.clones",
    "tools.comptuer",
  ]) {
    assert.ok(messages.includes(key), messages)
  }
  assert.equal(warning.mock.callCount(), 6)
  assert.equal(await readFile(path, "utf8"), source)
})

test("defaults malformed sections and normalizes invalid ngrok combinations", async (t) => {
  const root = await tempDir(t, "shellby-config-sections-")
  const path = join(root, "config.toml")
  const warning = t.mock.method(console, "warn", () => undefined)
  await writeFile(path, "tools = false\nui = []\n[shell]\nrtk = true\n")
  const loaded = loadPublicConfig(path)
  assert.deepEqual(loaded.tools, DEFAULT_PUBLIC_CONFIG.tools)
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

test("accepts equivalent TOML formatting and leaves it untouched during setup", async (t) => {
  const root = await tempDir(t, "shellby-config-format-")
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

test("MCP and ngrok API ports accept overrides and default invalid values individually", async (t) => {
  const root = await tempDir(t, "shellby-config-ports-")
  const { configPath } = await initializeOpenChatXConfig(root)
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
  const { configPath } = await initializeOpenChatXConfig(root)
  for (const source of [
    "[tools\ncomputer = false\n",
    "[tools]\ncomputer = false\ncomputer = true\n",
  ]) {
    await writeFile(configPath, source)
    assert.throws(
      () => loadPublicConfig(configPath),
      /Invalid openchatx-mcp config syntax.*\n\d+:.*\^/su
    )
    assert.equal((await initializeOpenChatXConfig(root)).updated, false)
    assert.equal(await readFile(configPath, "utf8"), source)
  }
})

test("PM2 uses normalized ngrok settings from the shared loader", async (t) => {
  const root = await tempDir(t, "shellby-config-pm2-")
  const { configPath } = await initializeOpenChatXConfig(root)
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
  const ngrok = module.exports.apps.find((app) => app.name === "openchatx-ngrok")!
  assert.ok(ngrok.args.includes("https://custom.ngrok.app"))
  assert.ok(ngrok.args.includes("http://127.0.0.1:3334"))
  assert.ok(ngrok.args.includes("/fake/override.json"))
  assert.equal(ngrok.args.includes("--pooling-enabled"), false)
})

test("ngrok enablement defaults on, accepts false, and preserves reserved settings", async (t) => {
  const root = await tempDir(t, "shellby-config-local-")
  const { configPath } = await initializeOpenChatXConfig(root)
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
  await initializeOpenChatXConfig(root)
  assert.equal(await readFile(configPath, "utf8"), source)
  t.mock.method(console, "warn", () => undefined)
  await writeFile(configPath, '[ngrok]\nenabled = "false"')
  assert.equal(loadPublicConfig(configPath).ngrok.enabled, true)
})

test("local PM2 ecosystem needs neither ngrok executable nor native configuration", async (t) => {
  const root = await tempDir(t, "shellby-config-local-pm2-")
  const { configPath } = await initializeOpenChatXConfig(root)
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
  assert.equal(module.exports.apps[0]?.name, "openchatx-mcp")
})
