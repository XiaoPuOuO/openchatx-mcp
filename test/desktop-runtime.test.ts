import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

const root = join(import.meta.dirname, "..")

test("macOS desktop app owns runtime lifecycle without npm or PM2", async () => {
  const source = await readFile(join(root, "desktop/macos/OpenChatXApp.swift"), "utf8")
  assert.match(source, /startBackend/u)
  assert.match(source, /startTunnel/u)
  assert.match(source, /WKWebView/u)
  assert.match(source, /applicationSupportDirectory/u)
  assert.doesNotMatch(source, /\bnpm\b/u)
  assert.doesNotMatch(source, /\bpm2\b/iu)
  assert.match(source, /buildMainMenu/u)
  assert.match(source, /NSText\.copy/u)
  assert.match(source, /NSText\.paste/u)
  assert.match(source, /NSText\.cut/u)
  assert.match(source, /NSText\.selectAll/u)
})

test("desktop packaging emits an app and DMG with bundled Node and tunnel-client", async () => {
  const source = await readFile(join(root, "scripts/desktop-macos.ts"), "utf8")
  assert.match(source, /OpenChatX\.app/u)
  assert.match(source, /OpenChatX\.dmg/u)
  assert.match(source, /nodejs\.org\/dist/u)
  assert.match(source, /tunnel-client/u)
  assert.match(source, /codesign/u)
  assert.match(source, /hdiutil/u)
})

test("Windows desktop app owns runtime lifecycle with WebView2 and Windows Credential Manager", async () => {
  const source = await readFile(join(root, "desktop/windows/Program.cs"), "utf8")
  assert.match(source, /WebView2/u)
  assert.match(source, /StartBackend/u)
  assert.match(source, /StartTunnel/u)
  assert.match(source, /LocalApplicationData/u)
  assert.match(source, /CredWrite/u)
  assert.match(source, /Kill\(entireProcessTree: true\)/u)
  assert.doesNotMatch(source, /\bpm2\b/iu)
})

test("Windows desktop packaging cross-builds x64 and arm64 with bundled Node and tunnel-client", async () => {
  const source = await readFile(join(root, "scripts/desktop-windows.ts"), "utf8")
  assert.match(source, /win-x64/u)
  assert.match(source, /win-arm64/u)
  assert.match(source, /nodejs\.org\/dist/u)
  assert.match(source, /openai\/tunnel-client\/releases\/download/u)
  assert.match(source, /OpenChatX-windows-/u)
  assert.match(source, /dotnet/u)
  assert.match(source, /signtool/u)
  assert.match(source, /Inno Setup 6/u)
  assert.match(
    await readFile(join(root, "desktop/windows/OpenChatX.iss"), "utf8"),
    /OpenChatX-Setup/u
  )
})

test("desktop distributable defaults do not copy repository MCP or provider config", async () => {
  const source = await readFile(join(root, "scripts/desktop-macos.ts"), "utf8")
  assert.match(source, /desktop\/runtime-defaults\/mcp-servers\.json/u)
  assert.match(source, /desktop\/runtime-defaults\/subagents\.json/u)
  const mcpDefaults = JSON.parse(
    await readFile(join(root, "desktop/runtime-defaults/mcp-servers.json"), "utf8")
  )
  const subagentDefaults = JSON.parse(
    await readFile(join(root, "desktop/runtime-defaults/subagents.json"), "utf8")
  )
  assert.deepEqual(mcpDefaults, {})
  assert.deepEqual(subagentDefaults, { providers: {}, models: {} })
})
