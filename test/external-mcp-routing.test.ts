import assert from "node:assert/strict"
import test from "node:test"

import { normalizeExternalToolArguments } from "../src/external-mcp/registry.js"

test("normalizes fully-qualified nested tool names for MCP call_tool routers", () => {
  const toolset = "editor_toolset.toolsets.scene.SceneTools"
  assert.deepEqual(
    normalizeExternalToolArguments("call_tool", {
      toolset_name: toolset,
      tool_name: `${toolset}.find_actors`,
      arguments: { name: "Player" },
    }),
    {
      toolset_name: toolset,
      tool_name: "find_actors",
      arguments: { name: "Player" },
    }
  )
})

test("does not rewrite unrelated or already-short external tool arguments", () => {
  const args = {
    toolset_name: "editor_toolset.toolsets.scene.SceneTools",
    tool_name: "find_actors",
  }
  assert.equal(normalizeExternalToolArguments("call_tool", args), args)
  assert.equal(normalizeExternalToolArguments("describe_toolset", args), args)
})
