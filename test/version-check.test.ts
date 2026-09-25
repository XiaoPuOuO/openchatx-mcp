import assert from "node:assert/strict"
import test from "node:test"

import { compareVersions } from "../src/update/version-check.js"

test("compares semantic release versions", () => {
  assert.equal(compareVersions("0.2.1", "0.2.0"), 1)
  assert.equal(compareVersions("v1.0.0", "0.9.9"), 1)
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0)
  assert.equal(compareVersions("0.1.9", "0.2.0"), -1)
})
