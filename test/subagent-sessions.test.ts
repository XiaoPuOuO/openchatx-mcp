import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import {
  getAgentIdentity,
  runWithAgent,
  runWithAgentId,
  setAgentProjectId,
  setAgentSkillSelection,
  setAgentTaskSlug,
} from "../src/agent/context.js"
import { createAgentObserver } from "../src/agent/observer.js"
import { installToolRegistrationBoundary } from "../src/mcp/tool-registration-boundary.js"
import { safeToolArguments } from "../src/subagents/agent-sessions.js"
import { subagentConfigSchema } from "../src/subagents/config.js"
import { SubagentRuntime } from "../src/subagents/runtime.js"
import { type SessionRecord, SubagentSessionStore } from "../src/subagents/session-store.js"
import { registerSubagentTools } from "../src/tools/subagents/subagent-tools.js"

test("SQLite records cascade with owner deletion and are reset on restart", () => {
  const folder = mkdtempSync(join(tmpdir(), "openchatx-subagent-store-"))
  const dbPath = join(folder, "subagents.db")
  try {
    const store = new SubagentSessionStore(dbPath)
    assert.equal(statSync(dbPath).mode & 0o777, 0o600)
    const created = new Date().toISOString()
    const root: SessionRecord = {
      job_id: "root-job",
      session_id: "root-worker",
      profile: "fixture",
      provider: "local",
      model: "demo",
      title: "parent task",
      root_owner: "chat-one",
      owner: "chat-one",
      depth: 1,
      status: "completed",
      created_at: created,
      updated_at: created,
      pending_guidance: 0,
      bootstrapped: true,
      notified: false,
    }
    const child: SessionRecord = {
      ...root,
      job_id: "child-job",
      session_id: "child-worker",
      title: "child task",
      parent_id: root.job_id,
      root_owner: "chat-one",
      owner: root.session_id,
      depth: 2,
    }
    const other: SessionRecord = {
      ...root,
      job_id: "other-job",
      session_id: "other-worker",
      root_owner: "chat-two",
      owner: "chat-two",
    }
    store.create(root, [{ role: "user", content: "parent task" }])
    store.create(child, [{ role: "user", content: "child task" }])
    store.create(other, [{ role: "user", content: "unrelated task" }])
    store.addEvent(child.job_id, {
      id: "event-one",
      role: "tool",
      time: created,
      text: "tool output",
    })
    assert.equal(store.list().length, 3)
    assert.equal(store.messages(child.job_id)[0]?.content, "child task")
    assert.equal(store.events(child.job_id)[0]?.text, "tool output")
    const sqlite = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = sqlite.prepare("SELECT data FROM session WHERE job_id=?").get("child-job")
      assert.ok(row && typeof row.data === "string")
      assert.doesNotMatch(row.data, /"messages"|"controller"/u)
    } finally {
      sqlite.close()
    }
    assert.deepEqual(
      store.deleteOwner("chat-one").sort((a, b) => a.localeCompare(b)),
      ["child-job", "root-job"]
    )
    assert.equal(store.get("root-job"), undefined)
    assert.equal(store.get("child-job"), undefined)
    assert.deepEqual(store.events("child-job"), [])
    assert.deepEqual(store.messages("child-job"), [])
    assert.equal(store.get("other-job")?.job_id, "other-job")
    store.dispose()
    assert.equal(existsSync(dbPath), false)
    // Simulate stale data from an unclean previous process.
    const crashed = new DatabaseSync(dbPath)
    crashed.exec(
      "CREATE TABLE stale_record (content TEXT); INSERT INTO stale_record VALUES ('previous chat');"
    )
    crashed.close()
    const restarted = new SubagentSessionStore(dbPath)
    assert.deepEqual(restarted.list(), [])
    restarted.dispose()
    assert.equal(existsSync(dbPath), false)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test("tool input preview redacts nested credentials without changing other arguments", () => {
  const preview = safeToolArguments({
    path: "/tmp/fixture",
    api_key: "test-key",
    nested: { Authorization: "Bearer abc", list: [{ password: "secret", value: 5 }] },
    arguments_json: JSON.stringify({ token: "test-token", count: 1 }),
  })
  assert.match(preview, /\/tmp\/fixture/u)
  const value: unknown = JSON.parse(preview)
  assert.ok(value && typeof value === "object" && "arguments_json" in value)
  assert.ok(typeof value.arguments_json === "string")
  assert.deepEqual(JSON.parse(value.arguments_json), { token: "[redacted]", count: 1 })
  assert.doesNotMatch(preview, /test-key|Bearer abc|secret|test-token/u)
})

test("Subagent sessions perform real tool calls, recursively delegate and accept queued guidance", async (t) => {
  let requests = 0
  let longLogSeenByModel = ""
  const longToolLog = [
    ...Array.from(
      { length: 1200 },
      (_, i) =>
        `log line ${String(i + 1).padStart(4, "0")}: checking provider requests, tool limits, and session state`
    ),
    "FINAL-LOG-LINE",
  ].join("\n")
  const server = createServer(async (req, res) => {
    const chunks: Uint8Array[] = []
    for await (const chunk of req) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages: Array<{ role: string; content: string }>
    }
    requests += 1
    const messages = payload.messages
    assert.match(messages[0]?.content ?? "", /Shared session instructions/u)
    const task = messages.find((message) => message.role === "user")?.content
    const last = messages.at(-1)
    const answer = (content: string, calls?: unknown[]) => ({
      choices: [
        { message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) } },
      ],
      usage: { completion_tokens_details: { reasoning_tokens: 9 } },
    })
    let response: unknown
    if (task === "parent" && last?.role === "user") {
      response = answer("", [
        {
          id: "nested-call",
          type: "function",
          function: {
            name: "subagent_run",
            arguments: JSON.stringify({
              action: "run",
              model: "fixture",
              task: "child",
            }),
          },
        },
      ])
    } else if (task === "child") {
      response = answer("Child completed using inherited tools.")
    } else if (task === "echo task" && last?.role === "user") {
      response = answer("", [
        {
          id: "echo-call",
          type: "function",
          function: { name: "echo", arguments: '{"text":"tool invoked"}' },
        },
      ])
    } else if (task === "echo task") {
      response = answer(`Tool result: ${last?.content}`)
    } else if (task === "plan task" && last?.role === "user") {
      response = answer("", [
        {
          id: "plan-call",
          type: "function",
          function: {
            name: "subagent_plan",
            arguments: JSON.stringify({
              steps: [
                { description: "Inspect files", status: "completed" },
                { description: "Implement fix", status: "in_progress" },
              ],
            }),
          },
        },
      ])
    } else if (task === "plan task") {
      response = answer("Plan saved.")
    } else if (task === "long log" && last?.role === "user") {
      response = answer("", [
        {
          id: "long-log-call",
          type: "function",
          function: { name: "long_log", arguments: "{}" },
        },
      ])
    } else if (task === "long log") {
      longLogSeenByModel = last?.content ?? ""
      response = answer("Long log processed.")
    } else if (
      task === "guide" &&
      messages.some((message) => message.content?.includes("Human guidance:"))
    ) {
      response = answer("Guidance incorporated.")
    } else if (task === "guide") {
      await new Promise((resolve) => setTimeout(resolve, 80))
      response = answer("Initial response.")
    } else response = answer("Parent received child response.")
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(response))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== "string")

  const fixtureConfig = subagentConfigSchema.parse({
    providers: {
      local: { type: "openai-compatible", base_url: `http://127.0.0.1:${address.port}/v1` },
    },
    models: {
      fixture: {
        provider: "local",
        model: "demo-model",
        name: "Fixture",
        description: "Test",
        context_window: 10_000,
        enabled: true,
        execution_mode: "sync",
        thinking: { mode: "none" },
      },
    },
  })
  const runtime = new SubagentRuntime(fixtureConfig)
  const observer = createAgentObserver()
  let inheritedRouting: string | undefined
  const factory = () => {
    const mcp = new McpServer({ name: "subagent-fixture", version: "1.0.0" })
    installToolRegistrationBoundary(mcp, { structuredOutput: false, agentObserver: observer })
    mcp.registerTool(
      "start_here",
      {
        inputSchema: z.object({ mode: z.string(), task_id: z.string() }),
      },
      async () => ({ content: [{ type: "text", text: "Shared session instructions." }] })
    )
    mcp.registerTool(
      "echo",
      {
        inputSchema: z.object({ text: z.string() }),
      },
      async ({ text }) => {
        inheritedRouting = getAgentIdentity()?.projectRouting
        return { content: [{ type: "text", text }] }
      }
    )
    mcp.registerTool("long_log", { inputSchema: z.object({}) }, async () => ({
      content: [{ type: "text", text: longToolLog }],
    }))
    registerSubagentTools(mcp, runtime)
    return mcp
  }
  const testDir = mkdtempSync(join(tmpdir(), "openchatx-subagent-test-"))
  const storagePath = join(testDir, "sessions.db")
  runtime.enableAgentSessions(factory, observer, storagePath)
  t.after(() => {
    runtime.close()
    assert.equal(existsSync(storagePath), false)
    rmSync(testDir, { recursive: true, force: true })
  })

  const parentAgentId = runWithAgent("parent-conversation", () => {
    const identity = getAgentIdentity()
    const callId = observer.startTool(identity, "subagent_run", { task: "parent" })
    observer.finishTool(identity, callId, { ok: true })
    return identity?.agent
  })
  assert.ok(parentAgentId)

  const unrouted = await runWithAgent("unrouted-conversation", () =>
    runtime.run({ profileId: "fixture", task: "echo task" })
  )
  assert.match(unrouted.content, /PROJECT_ROUTING_REQUIRED/u)

  const echo = await runWithAgent("parent-conversation", () => {
    setAgentTaskSlug("parent-conversation")
    setAgentProjectId(undefined)
    return runtime.run({ profileId: "fixture", task: "echo task" })
  })
  assert.match(echo.content, /tool invoked/u)
  assert.equal(inheritedRouting, "unscoped")

  const planned = await runWithAgent("parent-conversation", () =>
    runtime.run({ profileId: "fixture", task: "plan task" })
  )
  assert.equal(planned.content, "Plan saved.")
  const planJob = runtime.listSessions().find((session) => session.title === "plan task")
  assert.ok(planJob)
  assert.deepEqual(runtime.sessionSnapshot(planJob.job_id).plan, [
    { description: "Inspect files", status: "completed" },
    { description: "Implement fix", status: "in_progress" },
  ])

  const longLogResult = await runWithAgent("parent-conversation", () =>
    runtime.run({ profileId: "fixture", task: "long log" })
  )
  assert.equal(longLogResult.content, "Long log processed.")
  const longLogJob = runtime.listSessions().find((session) => session.title === "long log")
  assert.ok(longLogJob)
  const toolEvent = runtime
    .sessionSnapshot(longLogJob.job_id)
    .events.find((event) => event.tool === "long_log")
  assert.ok(toolEvent)
  assert.ok(toolEvent.text.length > 48_000)
  assert.match(toolEvent.text, /FINAL-LOG-LINE/u)
  assert.ok(longLogSeenByModel.length < 50_000)
  assert.doesNotMatch(longLogSeenByModel, /FINAL-LOG-LINE/u)

  const first = runtime
    .listSessions()
    .find((session) => session.title === "echo task" && session.owner_agent_id === parentAgentId)
  assert.ok(first)
  assert.ok(runtime.sessionSnapshot(first.job_id).events.some((event) => event.role === "tool"))
  assert.ok(
    runtime
      .sessionSnapshot(first.job_id)
      .events.some((event) => event.role === "thinking" && event.reasoningTokens === 9)
  )
  assert.ok(first.worker_agent_id)
  assert.ok(
    runtime
      .sessionSnapshot(first.job_id)
      .events.some((event) => event.role === "tool" && event.input?.includes("tool invoked"))
  )

  const delegated = await runWithAgent("parent-conversation", () =>
    runtime.run({ profileId: "fixture", task: "parent" })
  )
  assert.match(delegated.content, /Parent received/u)
  const sessions = runtime.listSessions()
  const child = sessions.find((session) => session.parent_id)
  assert.ok(child)
  assert.equal(child.status, "completed")
  assert.equal(runtime.sessionSnapshot(child.job_id).depth, 2)
  assert.equal(child.owner_agent_id, parentAgentId)
  assert.equal(child.title, "child")
  assert.ok(requests >= 5)

  const pending = runWithAgent("parent-conversation", () =>
    runtime.startAsync({ profileId: "fixture", task: "guide" }, "parent-conversation")
  )
  const mcp = factory()
  const steeringClient = new Client({ name: "steer-fixture", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(serverTransport), steeringClient.connect(clientTransport)])
  t.after(() => Promise.allSettled([mcp.close(), steeringClient.close()]))
  const steeringAgentId = "123e4567-e89b-42d3-a456-426614174000"
  const steered = await runWithAgent("parent-conversation", () =>
    runWithAgentId(
      steeringAgentId,
      () => {
        setAgentTaskSlug("subagent-steer-test")
        setAgentProjectId(undefined)
        setAgentSkillSelection(null)
        return steeringClient.callTool({
          name: "subagent_steer",
          arguments: {
            job_id: pending.job_id,
            message: "Please focus on safety.",
            agent_id: steeringAgentId,
          },
        })
      },
      "parent-conversation"
    )
  )
  assert.notEqual(steered.isError, true, JSON.stringify(steered.content))
  for (
    let tries = 0;
    tries < 100 && runtime.getJob(pending.job_id, "parent-conversation").status === "running";
    tries++
  )
    await new Promise((resolve) => setTimeout(resolve, 12))
  assert.equal(
    runtime.getJob(pending.job_id, "parent-conversation").result?.content,
    "Guidance incorporated."
  )
  assert.ok(
    runtime
      .sessionSnapshot(pending.job_id)
      .events.some((event) => event.role === "guidance" && event.status === "delivered")
  )
  assert.throws(() => runtime.getJob(pending.job_id, "different-user"), /not found/u)

  const [duplicateA, duplicateB] = runWithAgent("parent-conversation", () => [
    runtime.startAsync({ profileId: "fixture", task: "child" }, "parent-conversation"),
    runtime.startAsync({ profileId: "fixture", task: "echo task" }, "parent-conversation"),
  ])
  assert.notEqual(duplicateA.job_id, duplicateB.job_id)
  for (
    let i = 0;
    i < 100 &&
    [duplicateA, duplicateB].some(
      (job) => runtime.getJob(job.job_id, "parent-conversation").status === "running"
    );
    i++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 12))
  }
  const list = runtime.listSessions()
  const entries = [duplicateA.job_id, duplicateB.job_id].map((id) =>
    list.find((session) => session.job_id === id)
  )
  assert.deepEqual(
    entries.map((session) => session?.title),
    ["child", "echo task"]
  )
  assert.ok(
    entries.every(
      (session) => session?.profile === "fixture" && session.owner_agent_id === parentAgentId
    )
  )

  // Manual stop aborts in-flight model work, keeps its history and does not mark failure.
  const beforeStopRequestCount = requests
  const toStop = runWithAgent("parent-conversation", () =>
    runtime.startAsync({ profileId: "fixture", task: "guide" }, "parent-conversation")
  )
  // Ensure the model request is actually pending, rather than stopping before fetch.
  for (let i = 0; i < 100; i++) {
    if (requests > beforeStopRequestCount) break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.ok(requests > beforeStopRequestCount)
  assert.throws(() => runtime.stopSession(toStop.job_id, "different-user"), /not found/u)
  const stopped = runtime.stopSession(toStop.job_id, "parent-conversation")
  assert.equal(stopped.status, "stopped")
  assert.equal(stopped.error, undefined)
  assert.ok(stopped.events.some((event) => event.role === "user"))
  assert.ok(stopped.events.every((event) => event.status !== "running"))
  assert.equal(runtime.getJob(toStop.job_id, "parent-conversation").status, "stopped")
  await new Promise((resolve) => setTimeout(resolve, 110))
  assert.equal(runtime.sessionSnapshot(toStop.job_id).status, "stopped")
  // A stopped session still owns its slot and can be continued with guidance.
  const resumed = runtime.steerSession(toStop.job_id, "continue", "parent-conversation")
  assert.equal(resumed.job_id, toStop.job_id)
  for (
    let i = 0;
    i < 100 && runtime.getJob(toStop.job_id, "parent-conversation").status === "running";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 12))
  assert.equal(runtime.getJob(toStop.job_id, "parent-conversation").status, "completed")

  // Delete a parent while another async job is active; it must not recreate rows.
  const stillRunning = runWithAgent("parent-conversation", () =>
    runtime.startAsync({ profileId: "fixture", task: "guide" }, "parent-conversation")
  )
  const removed = runtime.removeOwnerSession("parent-conversation")
  assert.ok(removed >= 5)
  assert.throws(
    () => runtime.getJob(stillRunning.job_id, "parent-conversation"),
    /Unknown subagent/u
  )
  assert.throws(() => runtime.sessionSnapshot(child.job_id), /Unknown subagent/u)
  assert.ok(runtime.listSessions().every((session) => session.owner_agent_id !== parentAgentId))
  // An unrelated ChatGPT conversation keeps its own sessions and history.
  assert.ok(runtime.listSessions().some((session) => session.title === "echo task"))
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.ok(runtime.listSessions().every((session) => session.owner_agent_id !== parentAgentId))

  runtime.updateConfig({
    ...fixtureConfig,
    limits: { max_depth: 1, max_children_per_agent: 2 },
  })
  const [slotA, slotB] = runWithAgent("slot-owner", () => {
    setAgentProjectId(undefined)
    return [
      runtime.startAsync({ profileId: "fixture", task: "child" }, "slot-owner"),
      runtime.startAsync({ profileId: "fixture", task: "echo task" }, "slot-owner"),
    ]
  })
  assert.notEqual(slotA.job_id, slotB.job_id)
  assert.throws(
    () =>
      runWithAgent("slot-owner", () =>
        runtime.startAsync({ profileId: "fixture", task: "child" }, "slot-owner")
      ),
    /slots full: 2\/2/u
  )
  // Steering reuses the same slot, even if the original work has finished.
  assert.equal(runtime.steerSession(slotA.job_id, "continue", "slot-owner").job_id, slotA.job_id)
  assert.equal(runtime.deleteSession(slotA.job_id, "slot-owner"), 1)
  const replacement = runWithAgent("slot-owner", () =>
    runtime.startAsync({ profileId: "fixture", task: "child" }, "slot-owner")
  )
  assert.notEqual(replacement.job_id, slotA.job_id)

  const depthRun = await runWithAgent("depth-owner", () => {
    setAgentProjectId(undefined)
    return runtime.run({ profileId: "fixture", task: "parent" })
  })
  assert.match(depthRun.content, /Parent received/u)
  const depthJob = runtime
    .listSessions()
    .find((job) => job.title === "parent" && job.owner_agent_id !== parentAgentId)
  assert.ok(depthJob)
  assert.ok(
    runtime
      .sessionSnapshot(depthJob.job_id)
      .events.some((event) => event.role === "tool" && /nesting limit/u.test(event.text))
  )
  assert.equal(
    runtime.listSessions().filter((session) => session.parent_id === depthJob.job_id).length,
    0
  )
  // Reconfiguring limits is applied to future creations, not existing slot records.
})
