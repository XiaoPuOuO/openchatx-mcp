import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { runWithAgent, setAgentProjectId } from "../src/agent/context.js"
import { createAgentObserver } from "../src/agent/observer.js"
import { installToolRegistrationBoundary } from "../src/mcp/tool-registration-boundary.js"
import { ProjectRegistry } from "../src/projects/project-registry.js"
import { SubagentFileSnapshots } from "../src/subagents/agent-file-snapshots.js"
import { SubagentHookRegistry } from "../src/subagents/agent-hooks.js"
import { agentPathsAllowed } from "../src/subagents/agent-path-scope.js"
import { toolDecision } from "../src/subagents/agent-permissions.js"
import { executeAgentProgram } from "../src/subagents/agent-program.js"
import { generateAgentTurn } from "../src/subagents/agent-provider.js"
import { overrideSubagentProfile } from "../src/subagents/agent-run-options.js"
import { contextThroughTurn } from "../src/subagents/agent-sessions.js"
import { openSubagentTools } from "../src/subagents/agent-tool-bridge.js"
import { subagentConfigSchema } from "../src/subagents/config.js"
import { SubagentRuntime } from "../src/subagents/runtime.js"

const config = subagentConfigSchema.parse({
  providers: { local: { type: "openai-compatible", base_url: "http://127.0.0.1:9999/v1" } },
  models: {
    fast: {
      provider: "local",
      model: "local-model",
      name: "Fast",
      description: "Test",
      context_window: 32000,
      thinking: {
        mode: "effort",
        request_field: "reasoning_effort",
        levels: ["low", "medium", "high"],
        default: "medium",
        default_enabled: true,
      },
    },
  },
})
const profile = config.models.fast
assert.ok(profile)

test("run overrides are applied without mutating the curated model", () => {
  const resolved = overrideSubagentProfile(profile, {
    thinking: true,
    thinkingEffort: "high",
    maxOutputTokens: 1800,
  })
  assert.equal(resolved.max_output_tokens, 1800)
  assert.equal(resolved.thinking.mode, "effort")
  if (resolved.thinking.mode === "effort") assert.equal(resolved.thinking.default, "high")
  if (profile.thinking.mode === "effort") assert.equal(profile.thinking.default, "medium")
  assert.throws(() => overrideSubagentProfile(profile, { thinkingEffort: "ultra" }), /Unsupported/u)
  assert.throws(() => overrideSubagentProfile(profile, { maxOutputTokens: 35000 }), /context/u)
})

test("agent tool permissions restrict read-only work and lazy tool routing", () => {
  const restricted = {
    ...profile,
    agent_mode: "explore" as const,
    permissions: { bash: "deny" as const },
  }
  assert.equal(toolDecision(restricted, "grep", true), "allow")
  assert.equal(toolDecision(restricted, "bash", false), "deny")
  assert.equal(toolDecision(restricted, "project_manage", false), "allow")
  assert.equal(toolDecision(restricted, "project_manage", false, { action: "remove" }), "deny")
  assert.equal(toolDecision(restricted, "project_manage", false, { action: "use" }), "allow")
  assert.equal(toolDecision(restricted, "tool_call", false, { tool: "builtin:bash" }), "deny")
  const permissive = {
    ...profile,
    permissions: { tool_call: "allow" as const, bash: "deny" as const },
  }
  assert.equal(toolDecision(permissive, "tool_call", false, { tool: "builtin:bash" }), "deny")
  assert.equal(toolDecision(permissive, "tool_call", false, { tool: "builtin:grep" }), "allow")
})

test("path-scoped agent limits filesystem access and rejects symlink escapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-allowed-paths-"))
  try {
    mkdirSync(join(root, "src"))
    mkdirSync(join(root, "secret"))
    writeFileSync(join(root, "src", "allowed.ts"), "safe")
    writeFileSync(join(root, "secret", "hidden.ts"), "hidden")
    symlinkSync(join(root, "secret"), join(root, "src", "outside"))
    const restricted = { ...profile, allowed_paths: ["src"] }
    assert.equal(toolDecision(restricted, "skill_search", true), "allow")
    assert.equal(toolDecision(restricted, "file_read", true), "allow")
    assert.equal(toolDecision(restricted, "bash", false), "deny")
    assert.equal(toolDecision(restricted, "subagent_run", false), "deny")
    assert.equal(
      toolDecision(restricted, "tool_call", false, { tool: "builtin:file_read" }),
      "deny"
    )
    assert.equal(
      await agentPathsAllowed(
        restricted,
        "file_read",
        { filePath: "src/allowed.ts" },
        root,
        "fixture"
      ),
      true
    )
    assert.equal(
      await agentPathsAllowed(
        restricted,
        "file_read",
        { filePath: "secret/hidden.ts" },
        root,
        "fixture"
      ),
      false
    )
    assert.equal(
      await agentPathsAllowed(
        restricted,
        "file_read",
        { filePath: "src/outside/hidden.ts" },
        root,
        "fixture"
      ),
      false
    )
    assert.equal(
      await agentPathsAllowed(restricted, "grep", { pattern: "safe" }, root, "fixture"),
      false
    )
    assert.equal(
      await agentPathsAllowed(
        restricted,
        "grep",
        { pattern: "safe", path: "src" },
        root,
        "fixture"
      ),
      true
    )
    assert.equal(
      await agentPathsAllowed(
        restricted,
        "file_read",
        { filePath: "src/allowed.ts", project_id: "other" },
        root,
        "fixture"
      ),
      false
    )
    assert.equal(
      await agentPathsAllowed(
        restricted,
        "apply_patch",
        {
          patch: "*** Begin Patch\n*** Update File: src/allowed.ts\n*** End Patch",
        },
        root,
        "fixture"
      ),
      true
    )
    assert.equal(
      await agentPathsAllowed(
        restricted,
        "apply_patch",
        {
          patch: "*** Begin Patch\n*** Update File: secret/hidden.ts\n*** End Patch",
        },
        root,
        "fixture"
      ),
      false
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("conversation fork retains selected tool replies without altering original history", () => {
  const history = [
    { role: "system" as const, content: "instructions" },
    { role: "user" as const, content: "task" },
    { role: "assistant" as const, content: "", calls: [{ id: "c1", name: "grep", arguments: {} }] },
    { role: "tool" as const, content: "found", callId: "c1", name: "grep" },
    { role: "assistant" as const, content: "done" },
    { role: "user" as const, content: "new request" },
    { role: "assistant" as const, content: "new answer" },
  ]
  assert.deepEqual(contextThroughTurn(history, 0), history.slice(0, 2))
  assert.deepEqual(contextThroughTurn(history, 1), history.slice(0, 4))
  assert.deepEqual(contextThroughTurn(history, 2), history.slice(0, 5))
  assert.deepEqual(contextThroughTurn(history), history)
  assert.equal(history.length, 7)
  assert.throws(() => contextThroughTurn(history, 4), /between 0 and 3/u)
})

test("dataflow program overlaps reads, barriers writes and resolves previous results", async () => {
  let reads = 0
  let peak = 0
  const writes: string[] = []
  const results = await executeAgentProgram(
    {
      steps: [
        { id: "one", tool: "grep", arguments: { value: "a" } },
        { id: "two", tool: "grep", arguments: { value: "b" } },
        { id: "three", tool: "grep", arguments: { value: "c" } },
        { id: "write", tool: "edit", arguments: { value: { $from: "one", path: "name" } } },
        { id: "four", tool: "grep", arguments: { value: "d" } },
      ],
    },
    {
      known: new Set(["grep", "edit"]),
      readOnly: new Set(["grep"]),
      call: async (tool, args) => {
        if (tool === "grep") {
          assert.equal(writes.length > 0 && args.value !== "d", false)
          reads += 1
          peak = Math.max(peak, reads)
          await new Promise((resolve) => setTimeout(resolve, 15))
          reads -= 1
          return { failed: false, text: JSON.stringify({ name: args.value }) }
        }
        assert.equal(reads, 0)
        writes.push(String(args.value))
        return { failed: false, text: "written" }
      },
    }
  )
  assert.equal(peak, 3)
  assert.deepEqual(writes, ["a"])
  assert.deepEqual(
    results.map((entry) => entry.id),
    ["one", "two", "three", "write", "four"]
  )
})

test("program denies unknown tools and prevents side effects after failure", async () => {
  await assert.rejects(
    executeAgentProgram(
      {
        steps: [{ id: "oops", tool: "agent_program", arguments: {} }],
      },
      {
        known: new Set(["agent_program"]),
        readOnly: new Set(),
        call: async () => ({ failed: false, text: "" }),
      }
    ),
    /forbidden/u
  )
  const called: string[] = []
  const outputs = await executeAgentProgram(
    {
      steps: [
        { id: "one", tool: "edit", arguments: {} },
        { id: "two", tool: "edit", arguments: {} },
      ],
    },
    {
      known: new Set(["edit"]),
      readOnly: new Set(),
      call: async (tool) => {
        called.push(tool)
        return { failed: true, text: "denied" }
      },
    }
  )
  assert.equal(outputs.length, 1)
  assert.equal(called.length, 1)
})

test("file snapshots undo and redo only when on-disk content still matches", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-snapshot-"))
  const target = join(root, "sample.ts")
  try {
    writeFileSync(target, "before\n")
    const tracker = new SubagentFileSnapshots()
    const capture = await tracker.capture("job", root, {
      id: "call",
      name: "file_edit",
      arguments: { filePath: target },
    })
    assert.ok(capture)
    writeFileSync(target, "after\n")
    await tracker.complete(capture)
    const snapshot = tracker.list("job")[0]
    assert.ok(snapshot)
    assert.match(snapshot.changes[0]?.diff ?? "", /-before/u)
    await tracker.restore("job", snapshot.id, "undo")
    assert.equal(readFileSync(target, "utf8"), "before\n")
    await tracker.restore("job", snapshot.id, "redo")
    assert.equal(readFileSync(target, "utf8"), "after\n")
    writeFileSync(target, "user edit\n")
    await assert.rejects(
      tracker.restore("job", snapshot.id, "undo"),
      /changed since this snapshot/u
    )
    assert.equal(readFileSync(target, "utf8"), "user edit\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("lifecycle beforeTool can veto while observer failures do not change completion", async () => {
  const hooks = new SubagentHookRegistry()
  let seen = 0
  hooks.register(async (event) => {
    if (event.type === "beforeTool" && event.call.name === "denied")
      throw new Error("blocked by hook")
    if (event.type === "onComplete") seen += 1
  })
  hooks.register(() => {
    throw new Error("listener unavailable")
  })
  await assert.rejects(
    hooks.emit({
      type: "beforeTool",
      sessionId: "s",
      jobId: "j",
      call: { id: "1", name: "denied", arguments: {} },
    }),
    /blocked by hook/u
  )
  await hooks.emit({ type: "onComplete", sessionId: "s", jobId: "j", content: "done" })
  assert.equal(seen, 1)
})

test("full Subagent loop records nested program tools, hooks, and file snapshots", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "openchatx-subagent-program-"))
  const filename = join(folder, "sample.ts")
  writeFileSync(filename, "before\n")
  const project = new ProjectRegistry(join(folder, "projects.json"))
  await project.upsert({ id: "fixture", name: "Fixture", path: folder })
  const observer = createAgentObserver()
  let modelRequests = 0
  const llm = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      tools: Array<{ function: { name: string } }>
      messages: Array<{ role: string }>
      max_tokens?: number
    }
    modelRequests += 1
    if (modelRequests === 1) {
      assert.ok(payload.tools.some((tool) => tool.function.name === "agent_program"))
      assert.equal(payload.max_tokens, 128)
    }
    const completed = payload.messages.some((message) => message.role === "tool")
    const tool_calls = completed
      ? undefined
      : [
          {
            id: "batch-one",
            type: "function",
            function: {
              name: "agent_program",
              arguments: JSON.stringify({
                steps: [
                  { id: "search", tool: "grep", arguments: { query: "needle" } },
                  {
                    id: "edit",
                    tool: "file_edit",
                    arguments: { filePath: filename, content: "after\n" },
                  },
                ],
              }),
            },
          },
        ]
    res.setHeader("Content-Type", "application/json")
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: completed ? "Program finished." : "",
              ...(tool_calls ? { tool_calls } : {}),
            },
          },
        ],
      })
    )
  })
  await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve))
  const address = llm.address()
  assert.ok(address && typeof address !== "string")
  const runtime = new SubagentRuntime(
    subagentConfigSchema.parse({
      providers: {
        local: { type: "openai-compatible", base_url: `http://127.0.0.1:${address.port}/v1` },
      },
      models: {
        fixture: {
          provider: "local",
          model: "fixture",
          name: "Fixture",
          description: "Program",
          thinking: { mode: "none" },
          context_window: 10_000,
        },
      },
    })
  )
  const observed: string[] = []
  runtime.registerLifecycleHook((event) => {
    observed.push(
      event.type === "beforeTool" || event.type === "afterTool"
        ? `${event.type}:${event.call.name}`
        : event.type
    )
  })
  const factory = () => {
    const mcp = new McpServer({ name: "program-fixture", version: "1.0.0" })
    installToolRegistrationBoundary(mcp, { structuredOutput: false, agentObserver: observer })
    mcp.registerTool(
      "grep",
      { inputSchema: z.object({ query: z.string() }), annotations: { readOnlyHint: true } },
      async ({ query }) => ({ content: [{ type: "text", text: query }] })
    )
    mcp.registerTool(
      "file_edit",
      {
        inputSchema: z.object({ filePath: z.string(), content: z.string() }),
        annotations: { readOnlyHint: false },
      },
      async ({ filePath, content }) => {
        writeFileSync(filePath, content)
        return { content: [{ type: "text", text: "File changed." }] }
      }
    )
    return mcp
  }
  runtime.enableAgentSessions(factory, observer, join(folder, "sessions.db"), undefined, project)
  t.after(async () => {
    runtime.close()
    await new Promise<void>((resolve) => llm.close(() => resolve()))
    rmSync(folder, { recursive: true, force: true })
  })
  const result = await runWithAgent("parent-program-session", () => {
    setAgentProjectId("fixture")
    return runtime.run({ profileId: "fixture", task: "program task", maxOutputTokens: 128 })
  })
  assert.equal(result.content, "Program finished.")
  assert.equal(readFileSync(filename, "utf8"), "after\n")
  const session = runtime.listSessions().find((item) => item.title === "program task")
  assert.ok(session)
  const events = runtime.sessionSnapshot(session.job_id).events
  assert.deepEqual(
    events.filter((event) => event.role === "tool").map((event) => event.tool),
    ["agent_program", "grep", "file_edit"]
  )
  assert.ok(observed.includes("beforeTool:grep"))
  assert.ok(observed.includes("afterTool:file_edit"))
  assert.ok(observed.includes("onComplete"))
  const snapshot = runtime.sessionSnapshot(session.job_id).snapshots?.[0]
  assert.ok(snapshot)
  assert.equal(snapshot.changes[0]?.path, filename)
  await runtime.restoreSnapshot(session.job_id, snapshot.id, "undo")
  assert.equal(readFileSync(filename, "utf8"), "before\n")
  await runtime.restoreSnapshot(session.job_id, snapshot.id, "redo")
  assert.equal(readFileSync(filename, "utf8"), "after\n")
})

test("MCP media, embedded files, and per-agent approval reach the model safely", async (t) => {
  const image = Buffer.from("test-png-data").toString("base64")
  let approvals = 0
  const factory = () => {
    const server = new McpServer({ name: "media-fixture", version: "1.0.0" })
    server.registerTool(
      "media",
      {
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => ({
        content: [
          { type: "text" as const, text: "Media returned." },
          { type: "image" as const, mimeType: "image/png", data: image },
          {
            type: "resource" as const,
            resource: {
              uri: "file:///tmp/fixture.txt",
              mimeType: "text/plain",
              text: "Readme content.",
            },
          },
        ],
      })
    )
    server.registerTool(
      "secret",
      {
        inputSchema: z.object({}),
        annotations: { readOnlyHint: false },
      },
      async () => ({ content: [{ type: "text" as const, text: "secret" }] })
    )
    return server
  }
  const bridge = await openSubagentTools(
    factory,
    createAgentObserver(),
    {
      sessionId: "media-test-worker",
      profileId: "fast",
      policy: { ...profile, permissions: { media: "ask", secret: "deny" } },
      approveTool: async () => {
        approvals += 1
      },
    },
    false
  )
  t.after(() => bridge.close())
  assert.equal(
    bridge.specs.some((tool) => tool.name === "secret"),
    false
  )
  const result = await bridge.call({ id: "1", name: "media", arguments: {} })
  assert.equal(approvals, 1)
  assert.equal(result.failed, false)
  assert.match(result.text, /Readme content/u)
  assert.equal(result.attachments?.[0]?.mimeType, "image/png")
  assert.equal(result.attachments?.[0]?.data, image)

  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  let input: Record<string, unknown> | undefined
  globalThis.fetch = async (_url, options) => {
    input = JSON.parse(String(options?.body)) as Record<string, unknown>
    return Response.json({ choices: [{ message: { content: "Viewed" } }] })
  }
  const provider = config.providers.local
  assert.ok(provider)
  const answer = await generateAgentTurn({
    provider,
    providerId: "local",
    profile,
    messages: [{ role: "user", content: "Inspect the result.", attachments: result.attachments }],
    tools: [],
  })
  assert.equal(answer.text, "Viewed")
  const messages = input?.messages as Array<{ content: unknown[] }>
  assert.ok(JSON.stringify(messages[0]?.content).includes("data:image/png;base64"))
})

test("exhausted transient failures switch to a configured fallback profile", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  let primaryRequests = 0
  let backupRequests = 0
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://primary.example/")) {
      primaryRequests += 1
      return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
        status: 503,
        headers: { "retry-after": "0" },
      })
    }
    backupRequests += 1
    return Response.json({ choices: [{ message: { content: "Fallback succeeded." } }] })
  }
  const folder = mkdtempSync(join(tmpdir(), "subagent-failover-"))
  const runtime = new SubagentRuntime(
    subagentConfigSchema.parse({
      providers: {
        primary: { type: "openai-compatible", base_url: "https://primary.example/v1" },
        backup: { type: "openai-compatible", base_url: "https://backup.example/v1" },
      },
      models: {
        main: {
          provider: "primary",
          model: "main-model",
          name: "Main",
          description: "main",
          fallback_models: ["backup-profile"],
          thinking: { mode: "none" },
        },
        "backup-profile": {
          provider: "backup",
          model: "backup-model",
          name: "Backup",
          description: "backup",
          thinking: { mode: "none" },
        },
      },
    })
  )
  runtime.enableAgentSessions(
    () => new McpServer({ name: "fallback-tools", version: "1.0.0" }),
    createAgentObserver(),
    join(folder, "sessions.db")
  )
  t.after(() => {
    runtime.close()
    rmSync(folder, { recursive: true, force: true })
  })
  const answer = await runtime.run({ profileId: "main", task: "Recover the request." })
  assert.equal(answer.content, "Fallback succeeded.")
  assert.equal(backupRequests, 1)
  assert.equal(primaryRequests, 5)
  const sessions = runtime.listSessions()
  assert.equal(sessions[0]?.active_profile, "backup-profile")
  assert.ok(
    runtime
      .sessionSnapshot(sessions[0]?.job_id ?? "")
      .events.some((event) => event.role === "harness" && event.text.includes("Provider failover"))
  )
})
