import assert from "node:assert/strict"
import test from "node:test"

import {
  externalMcpConfigSchema,
  resolveDotExposure,
  resolveDotServerIds,
} from "../src/external-mcp/config.js"

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

test("Dot MCP exposure honors per-server settings and legacy allowlist fallback", () => {
  assert.deepEqual(resolveDotServerIds(config, ["blender", "unreal-engine"]), ["blender"])
  assert.deepEqual(resolveDotExposure(config, ["blender", "unreal-engine"]), {
    blender: { ...config.blender, dot: true },
    "unreal-engine": { ...config["unreal-engine"], dot: false },
    disabled: { ...config.disabled, dot: false },
  })
})

test("legacy empty allowlist keeps existing servers exposed until explicitly changed", () => {
  assert.deepEqual(resolveDotServerIds(config, []), ["blender"])
})
