import assert from "node:assert/strict"
import test from "node:test"

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
