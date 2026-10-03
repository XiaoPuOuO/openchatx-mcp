import assert from "node:assert/strict"
import test from "node:test"

import { buildSandboxExecArgv } from "../src/toolbox/sandbox-runner.js"

test("sandbox keeps Node permission isolation outside full-access mode", () => {
  const args = buildSandboxExecArgv({
    runtimePath: "/tmp/openchatx/tool.openchatx.mjs",
    permissions: ["filesystem"],
    fullAccess: false,
  })

  assert.equal(args.includes("--permission"), true)
  assert.equal(args.includes("--allow-fs-read=*"), true)
  assert.equal(args.includes("--allow-fs-write=*"), true)
})

test("sandbox removes permission restrictions only in full-access mode", () => {
  const args = buildSandboxExecArgv({
    runtimePath: "/tmp/openchatx/tool.openchatx.mjs",
    permissions: ["shell", "network", "filesystem", "secrets"],
    fullAccess: true,
  })

  assert.equal(args.includes("--permission"), false)
  assert.equal(
    args.some((arg) => arg.startsWith("--allow-fs-")),
    false
  )
  assert.equal(args.includes("--allow-child-process"), false)
})
