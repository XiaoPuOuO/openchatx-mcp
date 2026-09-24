import assert from "node:assert/strict"
import test from "node:test"

import { renderCapabilityCatalog } from "../src/tools/start-here/start-here.js"

test("renders one unified capability summary list", () => {
  const text = renderCapabilityCatalog([
    {
      id: "blender",
      name: "Blender",
      description: "3D modeling and scene control",
      kind: "mcp",
      invocation: "tool_search",
      available: true,
      toolCount: 12,
    },
    {
      id: "unreal",
      name: "Unreal Engine",
      description: "Editor automation",
      kind: "mcp",
      invocation: "tool_search",
      available: false,
      toolCount: 0,
    },
    {
      id: "qwen-fast",
      name: "Qwen Fast",
      description: "Fast high-volume mechanical work",
      kind: "agent",
      invocation: "subagent_run",
      available: true,
    },
    {
      id: "my-tools",
      name: "My Tools",
      description: "Project helpers",
      kind: "toolbox",
      invocation: "tool_search",
      available: true,
      toolCount: 3,
      skillCount: 1,
    },
  ])

  assert.match(text, /blender \(Blender\): available, 12 tools/u)
  assert.match(text, /unreal \(Unreal Engine\): unavailable, 0 tools/u)
  assert.match(text, /qwen-fast \(Qwen Fast\): available/u)
  assert.match(text, /my-tools \(My Tools\): available, 3 tools, 1 skills/u)
  assert.match(text, /capability_list/u)
  assert.doesNotMatch(text, /External MCP capabilities/u)
})

test("returns no capability appendix for an empty catalog", () => {
  assert.equal(renderCapabilityCatalog([]), "")
})
