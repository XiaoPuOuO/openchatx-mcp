import assert from "node:assert/strict"
import test from "node:test"

import { externalMcpConfigSchema } from "../src/external-mcp/config.js"

const config = externalMcpConfigSchema.parse({
  blender: {
    type: "remote",
    url: "http://127.0.0.1:3001/mcp",
    enabled: true,
  },
  "unreal-engine": {
    type: "remote",
    url: "http://127.0.0.1:3002/mcp",
    enabled: true,
    dot: false,
  },
  disabled: {
    type: "remote",
    url: "http://127.0.0.1:3003/mcp",
    enabled: false,
    dot: true,
  },
})

test("legacy configuration remains readable without activating a second service", () => {
  assert.equal(config["unreal-engine"]?.enabled, true)
  assert.equal(config.disabled?.enabled, false)
})
