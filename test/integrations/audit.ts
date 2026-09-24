import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { McpAuditLogger } from "../../src/server/audit/audit-log.js"
import { connectClient, startMcpHttpServer } from "./helpers.js"

test("audits tool calls made through the HTTP MCP boundary", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-audit-integration-"))
  const auditPath = join(root, "agent-commands.yaml")
  const running = await startMcpHttpServer({
    port: 0,
    auditLogger: new McpAuditLogger(auditPath),
  })
  t.after(async () => {
    await running.close()
    await rm(root, { recursive: true, force: true })
  })

  const connected = await connectClient(
    running.url,
    "audit-integration-client",
    undefined,
    false,
    "child-session"
  )
  t.after(() => connected.client.close())
  await connected.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "audit-integration" },
  })
  await connected.client.callTool({ name: "shell_list", arguments: {} })
  await connected.client.callTool({
    name: "skill_list",
    arguments: {},
  })

  const log = await readFile(auditPath, "utf8")
  assert.match(log, /shell_list/u)
  assert.match(log, /args: \{\}/u)
  assert.match(log, /--- # skill_list /u)
  assert.match(log, /session: "agent-1"/u)
  assert.doesNotMatch(log, /child-session/u)
})
