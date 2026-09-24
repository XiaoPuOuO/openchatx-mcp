import assert from "node:assert/strict"
import test from "node:test"

import { CapabilityRegistry } from "../src/capabilities/catalog.js"
import { renderCapabilityCatalog } from "../src/tools/start-here/start-here.js"

test("unified capability registry aggregates MCP, toolbox, agent, and provider capabilities", () => {
  const registry = new CapabilityRegistry(
    {
      connectedServers: ["blender"],
      toolCount: 12,
      capabilities: () => [
        {
          id: "blender",
          name: "Blender",
          description: "3D modeling and scene control",
          available: true,
          toolCount: 12,
        },
      ],
      registerTools() {},
      catalog: () => [],
      call: async () => undefined,
      reload: async () => undefined,
      close: async () => undefined,
    },
    {
      snapshots: () => [
        {
          id: "my-tools",
          name: "My Tools",
          description: "Project helpers",
          enabled: true,
          path: "/tmp/my-tools",
          tools: [{ name: "ship", enabled: true, required: false }],
          skills: [],
        },
      ],
    } as never,
    {
      profiles: () => [
        {
          id: "qwen-fast",
          name: "Qwen Fast",
          description: "Fast code analysis",
          provider: "qwen",
          model: "qwen",
          context_window: 100000,
          thinking: { mode: "none" as const },
        },
      ],
      providerSummaries: () => [{ id: "qwen", enabled: true, profileCount: 1 }],
    } as never
  )

  const listed = registry.list()
  assert.deepEqual(
    listed.map((capability) => capability.id),
    ["blender", "my-tools", "provider:qwen", "qwen-fast"]
  )
  assert.equal(registry.search("3D")[0]?.id, "blender")
  assert.equal(registry.search("code analysis")[0]?.id, "qwen-fast")

  const rendered = renderCapabilityCatalog(listed)
  assert.match(rendered, /blender \(Blender\): available/u)
  assert.match(rendered, /qwen-fast \(Qwen Fast\): available/u)
  assert.doesNotMatch(rendered, /External MCP capabilities/u)
})
