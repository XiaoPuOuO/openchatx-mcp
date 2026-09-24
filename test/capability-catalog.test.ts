import assert from "node:assert/strict"
import test from "node:test"

import { renderCapabilityCatalog } from "../src/tools/start-here/start-here.js"

test("renders lightweight MCP, subagent, and toolbox capability summaries", () => {
  const text = renderCapabilityCatalog({
    mcpServers: [
      {
        id: "blender",
        name: "Blender",
        description: "3D modeling and scene control",
        available: true,
        toolCount: 12,
      },
      {
        id: "unreal",
        name: "Unreal Engine",
        description: "Editor automation",
        available: false,
        toolCount: 0,
      },
    ],
    subagents: [
      {
        id: "qwen-fast",
        name: "Qwen Fast",
        description: "Fast high-volume mechanical work",
      },
    ],
    toolboxes: [
      {
        id: "my-tools",
        name: "My Tools",
        description: "Project helpers",
        toolCount: 3,
        skillCount: 1,
      },
    ],
  })

  assert.match(text, /blender \(Blender\): available, 12 tools/u)
  assert.match(text, /unreal \(Unreal Engine\): configured but unavailable/u)
  assert.match(text, /server="<id>"/u)
  assert.match(text, /qwen-fast \(Qwen Fast\)/u)
  assert.match(text, /my-tools \(My Tools\): 3 tools, 1 skills/u)
})

test("returns no capability appendix for an empty catalog", () => {
  assert.equal(renderCapabilityCatalog({ mcpServers: [], subagents: [], toolboxes: [] }), "")
})
