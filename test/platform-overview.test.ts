import assert from "node:assert/strict"
import test from "node:test"

import { PlatformOverviewService } from "../src/platform/overview.js"

test("platform overview aggregates counts, current work, and attention", async () => {
  const overview = new PlatformOverviewService({
    capabilities: { list: () => [{ id: "one" }, { id: "two" }] } as never,
    projects: {
      list: async () => [
        {
          id: "demo",
          name: "Demo",
          path: "/tmp/demo",
          permissions: { read: true, write: true, shell: false },
        },
      ],
    } as never,
    jobs: {
      list: async () => [
        {
          id: "running",
          label: "Build",
          status: "running",
          cwd: "/tmp/demo",
          projectId: "demo",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "failed",
          label: "Tests",
          status: "failed",
          cwd: "/tmp/demo",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } as never,
    health: {
      snapshot: async () => ({
        status: "degraded",
        checkedAt: "2026-01-01T00:00:00.000Z",
        components: [
          {
            id: "mcp:blender",
            kind: "mcp",
            name: "Blender",
            status: "unavailable",
            detail: "Configured but unavailable",
          },
        ],
      }),
    } as never,
    subagents: {
      providerSummaries: () => [{ id: "local", enabled: true, profileCount: 1 }],
      profiles: () => [{ id: "coder" }],
    } as never,
    teams: { list: async () => [{ id: "ship" }] } as never,
    workflows: { list: async () => [{ id: "release" }] } as never,
    nodes: { list: async () => [{ id: "desktop", enabled: true }] } as never,
    store: { list: async () => [{ id: "x", installed: false }] } as never,
    agents: {
      listAgents: () => [
        {
          id: "agent-1",
          projectId: "demo",
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
          recent: [],
          instructions: [],
        },
      ],
    } as never,
  })

  const snapshot = await overview.snapshot()
  assert.equal(snapshot.counts.capabilities, 2)
  assert.equal(snapshot.counts.projects, 1)
  assert.equal(snapshot.counts.nodes, 1)
  assert.equal(snapshot.projects[0]?.activeAgents, 1)
  assert.equal(snapshot.projects[0]?.runningJobs, 1)
  assert.equal(snapshot.currentWork[0]?.id, "running")
  assert.equal(snapshot.currentWork[0]?.projectId, "demo")
  assert.deepEqual(
    snapshot.needsAttention.map((item) => item.id).sort((a, b) => a.localeCompare(b)),
    ["failed", "mcp:blender"]
  )
})
