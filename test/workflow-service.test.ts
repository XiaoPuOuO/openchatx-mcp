import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { WorkflowService } from "../src/workflows/workflow-service.js"

test("Capability Composer persists workflows and passes prior results through templates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-workflows-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls: Array<{ id: string; args: Record<string, unknown> }> = []
  const service = new WorkflowService(
    {
      externalMcp: {
        connectedServers: [],
        toolCount: 0,
        capabilities: () => [],
        registerTools() {},
        catalog: () => [],
        async call(id, args) {
          calls.push({ id, args })
          return { value: args.value }
        },
        reload: async () => undefined,
        close: async () => undefined,
      },
    },
    join(root, "workflows.json")
  )

  await service.upsert({
    id: "pipeline",
    name: "Pipeline",
    steps: [
      {
        id: "first",
        kind: "tool",
        tool: "mcp:demo:first",
        arguments_json: '{"value":"{{input}}"}',
      },
      {
        id: "second",
        kind: "tool",
        tool: "mcp:demo:second",
        arguments_json: '{"value":{{steps.first}}}',
      },
    ],
  })

  const result = await service.run("pipeline", "hello", {
    mcpReq: { signal: new AbortController().signal },
  } as never)
  assert.equal(result.steps.length, 2)
  assert.deepEqual(calls[0], { id: "mcp:demo:first", args: { value: "hello" } })
  assert.deepEqual(calls[1], {
    id: "mcp:demo:second",
    args: { value: { value: "hello" } },
  })

  const restored = new WorkflowService({}, join(root, "workflows.json"))
  assert.equal((await restored.list())[0]?.id, "pipeline")
})
