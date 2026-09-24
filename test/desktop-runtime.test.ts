import assert from "node:assert/strict"
import process from "node:process"
import test from "node:test"

import { desktopInstallPlan } from "../scripts/desktop-runtime.js"

test("macOS desktop launcher starts OpenChatX and opens the dashboard", () => {
  const plan = desktopInstallPlan("/Users/test/My Project/openchatx-mcp", "darwin", "/Users/test")
  assert.equal(plan.launcherPath, "/Users/test/Applications/OpenChatX.app/Contents/MacOS/OpenChatX")
  assert.match(plan.content, /npm start/u)
  assert.match(plan.content, /127\.0\.0\.1:3333\/ui/u)
  assert.match(plan.content, /My Project/u)
})

test("Windows desktop launcher starts OpenChatX and opens the dashboard", () => {
  const previous = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local"
  try {
    const plan = desktopInstallPlan("C:\\src\\openchatx-mcp", "win32", "C:\\Users\\test")
    assert.equal(
      plan.launcherPath,
      "C:\\Users\\test\\AppData\\Local/OpenChatX/OpenChatX.cmd".replaceAll("/", "\\")
    )
    assert.match(plan.content, /call npm start/u)
    assert.match(plan.content, /127\.0\.0\.1:3333\/ui/u)
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous
  }
})
