import assert from "node:assert/strict"
import process from "node:process"
import test from "node:test"

import { compareVersions, selectDesktopAsset } from "../src/update/version-check.js"

test("compares semantic release versions", () => {
  assert.equal(compareVersions("0.2.1", "0.2.0"), 1)
  assert.equal(compareVersions("v1.0.0", "0.9.9"), 1)
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0)
  assert.equal(compareVersions("0.1.9", "0.2.0"), -1)
  assert.equal(compareVersions("1.0.0-beta.4", "1.0.0-beta.3"), 1)
  assert.equal(compareVersions("1.0.1-beta.1", "1.0.0-beta.3"), 1)
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.99"), 1)
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1)
})

test("selects the installer matching the Windows desktop architecture", (t) => {
  const previous = process.env.OPENCHATX_DESKTOP
  process.env.OPENCHATX_DESKTOP = "1"
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCHATX_DESKTOP
    else process.env.OPENCHATX_DESKTOP = previous
  })

  const assets = [
    {
      name: "OpenChatX-Setup-x64.exe",
      browser_download_url: "https://example.test/OpenChatX-Setup-x64.exe",
    },
    {
      name: "OpenChatX-Setup-arm64.exe",
      browser_download_url: "https://example.test/OpenChatX-Setup-arm64.exe",
    },
  ]
  assert.equal(selectDesktopAsset(assets, "win32", "x64")?.name, "OpenChatX-Setup-x64.exe")
  assert.equal(selectDesktopAsset(assets, "win32", "arm64")?.name, "OpenChatX-Setup-arm64.exe")
  assert.equal(selectDesktopAsset(assets, "darwin", "arm64"), undefined)
})
