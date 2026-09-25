import assert from "node:assert/strict"
import test from "node:test"

import { childProcessEnvironment, childStringEnvironment } from "../src/child-environment.js"

test("child process environment removes OpenChatX desktop runtime internals", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/Users/test",
    OPENCHATX_PUBLIC_CONFIG: "/private/config.toml",
    OPENCHATX_EXTERNAL_MCP_CONFIG: "/private/mcp.json",
    OPENCHATX_SUBAGENT_CONFIG: "/private/subagents.json",
    OPENCHATX_TOOLBOX_ROOT: "/private/toolboxes",
    OPENCHATX_AUDIT_LOG: "/private/audit.yaml",
    OPENCHATX_DESKTOP: "1",
  }
  const environment = childProcessEnvironment(source)
  assert.equal(environment.PATH, "/usr/bin")
  assert.equal(environment.HOME, "/Users/test")
  assert.equal(environment.OPENCHATX_PUBLIC_CONFIG, undefined)
  assert.equal(environment.OPENCHATX_EXTERNAL_MCP_CONFIG, undefined)
  assert.equal(environment.OPENCHATX_SUBAGENT_CONFIG, undefined)
  assert.equal(environment.OPENCHATX_TOOLBOX_ROOT, undefined)
  assert.equal(environment.OPENCHATX_AUDIT_LOG, undefined)
  assert.equal(environment.OPENCHATX_DESKTOP, undefined)

  const stringEnvironment = childStringEnvironment(source)
  assert.deepEqual(stringEnvironment, {
    PATH: "/usr/bin",
    HOME: "/Users/test",
  })
})
