import assert from "node:assert/strict"
import test from "node:test"

import { ToolError } from "../src/mcp/tool-error.js"
import {
  type AccessMode,
  migrateOperationalState,
  type OperationalState,
} from "../src/recovery/operational-state.js"
import { approvalFingerprint, type RuntimeApproval } from "../src/runtime/approval-store.js"
import { RuntimeControlService } from "../src/runtime/runtime-control.js"

type ApprovalInput = {
  toolName: string
  category: string
  reason: string
  argumentsValue: Record<string, unknown>
  source?: { kind: "builtin" | "toolbox" | "mcp"; id?: string }
}

function createHarness(
  mode: AccessMode,
  input: Partial<
    Pick<OperationalState, "dangerousActions" | "capabilityPermissions" | "toolRiskOverrides">
  > = {}
) {
  let state = migrateOperationalState({
    schemaVersion: 4,
    accessMode: mode,
    dangerousActions: input.dangerousActions ?? {},
    capabilityPermissions: input.capabilityPermissions ?? {},
    toolRiskOverrides: input.toolRiskOverrides ?? {},
  })
  const requests: ApprovalInput[] = []
  const records: RuntimeApproval[] = []

  const approvals = {
    async list() {
      return records.filter((approval) => approval.status !== "consumed")
    },
    async request(request: ApprovalInput) {
      const fingerprint = approvalFingerprint(
        request.toolName,
        request.argumentsValue,
        request.category
      )
      const existing = records.find(
        (approval) => approval.fingerprint === fingerprint && approval.status === "pending"
      )
      if (existing) return existing
      requests.push(request)
      const approval: RuntimeApproval = {
        id: `approval-${records.length + 1}`,
        fingerprint,
        toolName: request.toolName,
        category: request.category,
        reason: request.reason,
        createdAt: "2026-10-03T00:00:00.000Z",
        status: "pending",
        input: request.argumentsValue,
        ...(request.source ? { source: request.source } : {}),
      }
      records.push(approval)
      return approval
    },
    async decide(id: string, decision: "approve" | "deny" | "dismiss") {
      const approval = records.find((candidate) => candidate.id === id)
      if (!approval) throw new Error("unknown approval")
      approval.status =
        decision === "approve" ? "approved" : decision === "deny" ? "denied" : "consumed"
      return approval
    },
    async isApproved(toolName: string, argumentsValue: Record<string, unknown>, category: string) {
      const fingerprint = approvalFingerprint(toolName, argumentsValue, category)
      return records.some(
        (approval) =>
          approval.fingerprint === fingerprint &&
          (approval.status === "approved" || approval.status === "approved-once")
      )
    },
  }

  const runtime = new RuntimeControlService(approvals, {
    async load() {
      return structuredClone(state)
    },
    async update(updater) {
      const draft = structuredClone(state)
      state = updater(draft) ?? draft
      return structuredClone(state)
    },
  })

  return { runtime, requests }
}

async function expectApproval(
  runtime: RuntimeControlService,
  toolName: string,
  argumentsValue: Record<string, unknown>,
  source?: { kind: "builtin" | "toolbox" | "mcp"; id?: string }
) {
  let settled = false
  const authorization = runtime
    .authorize({ toolName, argumentsValue, ...(source ? { source } : {}) })
    .finally(() => {
      settled = true
    })
  const approval = await waitForPendingApproval(runtime)
  assert.equal(settled, false)
  await runtime.decideApproval(approval.id, "allow-operation")
  await authorization
}

async function waitForPendingApproval(runtime: RuntimeControlService): Promise<RuntimeApproval> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pending = (await runtime.listApprovals()).find(
      (approval) => approval.status === "pending"
    )
    if (pending) return pending
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("approval was not requested")
}

async function expectDeniedApproval(
  runtime: RuntimeControlService,
  toolName: string,
  argumentsValue: Record<string, unknown>
) {
  const authorization = runtime.authorize({ toolName, argumentsValue })
  const approval = await waitForPendingApproval(runtime)
  await runtime.decideApproval(approval.id, "deny")
  await assert.rejects(
    authorization,
    (error: unknown) => error instanceof ToolError && error.code === "APPROVAL_DENIED"
  )
}

test("allow-low-risk allows built-in read, create, and edit actions", async () => {
  const { runtime, requests } = createHarness("allow-low-risk")

  await runtime.authorize({ toolName: "file_read", argumentsValue: { filePath: "a.txt" } })
  await runtime.authorize({
    toolName: "file_write",
    argumentsValue: { filePath: "new.txt", content: "new" },
  })
  await runtime.authorize({
    toolName: "file_edit",
    argumentsValue: { filePath: "a.txt", oldString: "a", newString: "b" },
  })

  assert.equal(requests.length, 0)
})

test("allow-low-risk allows routine development commands", async () => {
  const { runtime, requests } = createHarness("allow-low-risk")

  for (const command of [
    "npm test",
    "npm run test:ci",
    "npm run desktop:build",
    "npm run desktop:smoke",
    "git status",
    "git add src/index.ts",
    'git commit -m "test"',
    "mkdir generated",
    "touch generated/example.txt",
    "Get-Date",
    "Get-PSDrive",
  ]) {
    await runtime.authorize({ toolName: "bash", argumentsValue: { command } })
  }

  assert.equal(requests.length, 0)
})

test("allow-low-risk still asks for risky package scripts", async () => {
  const { runtime, requests } = createHarness("allow-low-risk")

  await expectApproval(runtime, "bash", { command: "npm run release:build" })
  await expectApproval(runtime, "bash", { command: "npm run deploy:smoke" })

  assert.equal(requests.length, 2)
})

test("allow-low-risk asks before delete, remote git push, and destructive patches", async () => {
  const { runtime, requests } = createHarness("allow-low-risk")

  await expectApproval(runtime, "bash", { command: "rm important.txt" })
  await expectApproval(runtime, "bash", { command: "git push origin main" })
  await expectApproval(runtime, "apply_patch", {
    patch: "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch",
  })

  assert.equal(requests.length, 3)
})

test("an approved exact operation continues immediately and is remembered", async () => {
  const { runtime, requests } = createHarness("allow-low-risk")
  const input = { command: "rm disposable.txt" }

  const first = runtime.authorize({ toolName: "bash", argumentsValue: input })
  const approval = await waitForPendingApproval(runtime)
  await runtime.decideApproval(approval.id, "allow-operation")
  await first
  assert.equal(requests.length, 1)

  await runtime.authorize({ toolName: "bash", argumentsValue: input })
  assert.equal(requests.length, 1)

  await expectApproval(runtime, "bash", { command: "rm another-file.txt" })
  assert.equal(requests.length, 2)
})

test("denying an approval rejects only the waiting call instead of permanently denying its category", async () => {
  const { runtime, requests } = createHarness("allow-low-risk")

  await expectDeniedApproval(runtime, "bash", { command: "rm first.txt" })
  await expectApproval(runtime, "bash", { command: "rm second.txt" })

  assert.equal(requests.length, 2)
})

test("allow-low-risk asks before secrets capability access", async () => {
  const { runtime, requests } = createHarness("allow-low-risk")

  await expectApproval(
    runtime,
    "tool_call",
    {
      tool: "toolbox:demo:secret_read",
      arguments_json: "{}",
    },
    { kind: "builtin" }
  )

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.category, "credential-access")
})

test("allow-low-risk honors explicit dangerous-action allow and deny", async () => {
  const allowed = createHarness("allow-low-risk", {
    dangerousActions: { "filesystem-destructive": "allow" },
  })
  await allowed.runtime.authorize({
    toolName: "bash",
    argumentsValue: { command: "rm disposable.txt" },
  })
  assert.equal(allowed.requests.length, 0)

  const denied = createHarness("allow-low-risk", {
    dangerousActions: { "filesystem-destructive": "deny" },
  })
  await assert.rejects(
    () =>
      denied.runtime.authorize({
        toolName: "bash",
        argumentsValue: { command: "rm important.txt" },
      }),
    (error: unknown) => error instanceof ToolError && error.code === "DANGEROUS_ACTION_DENIED"
  )
})

test("allow-low-risk honors per-tool risk overrides", async () => {
  const { runtime, requests } = createHarness("allow-low-risk", {
    toolRiskOverrides: {
      "builtin:bash": "low",
      "builtin:file_read": "approval",
      "toolbox:demo:delete_everything": "low",
    },
  })

  await runtime.authorize({ toolName: "bash", argumentsValue: { command: "rm disposable.txt" } })
  await runtime.authorize({
    toolName: "tool_call",
    argumentsValue: { tool: "toolbox:demo:delete_everything", arguments_json: "{}" },
    source: { kind: "builtin" },
  })
  await expectApproval(runtime, "file_read", { filePath: "a.txt" })

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.category, "tool-risk:builtin:file_read")
})

test("always-question asks before low-risk actions too", async () => {
  const { runtime, requests } = createHarness("always-question")

  await expectApproval(runtime, "file_read", { filePath: "a.txt" })
  await expectApproval(runtime, "file_edit", {
    filePath: "a.txt",
    oldString: "a",
    newString: "b",
  })

  assert.equal(requests.length, 2)
})

test("always-question does not remember an exact operation after allowing it once", async () => {
  const { runtime, requests } = createHarness("always-question")
  const input = { filePath: "a.txt" }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const authorization = runtime.authorize({ toolName: "file_read", argumentsValue: input })
    const approval = await waitForPendingApproval(runtime)
    await runtime.decideApproval(approval.id, "approve-once")
    await authorization
  }

  assert.equal(requests.length, 2)
})

test("cancelling a waiting approval rejects the call", async () => {
  const { runtime } = createHarness("allow-low-risk")
  const controller = new AbortController()
  const authorization = runtime.authorize({
    toolName: "bash",
    argumentsValue: { command: "rm disposable.txt" },
    signal: controller.signal,
  })
  await waitForPendingApproval(runtime)
  controller.abort()

  await assert.rejects(
    authorization,
    (error: unknown) => error instanceof ToolError && error.code === "APPROVAL_CANCELLED"
  )
})

test("full-access bypasses approvals and grants all sandbox permissions", async () => {
  const { runtime, requests } = createHarness("full-access", {
    dangerousActions: { "filesystem-destructive": "deny" },
    capabilityPermissions: {
      "toolbox:demo": { shell: "deny", network: "deny", filesystem: "deny", secrets: "deny" },
    },
  })

  const grant = await runtime.authorize({
    toolName: "tool_call",
    argumentsValue: {
      tool: "toolbox:demo:secret_shell_delete",
      arguments_json: JSON.stringify({ command: "rm -rf /tmp/example" }),
    },
    source: { kind: "builtin" },
  })

  assert.equal(grant.accessMode, "full-access")
  assert.deepEqual(grant.permissions.sort(), ["filesystem", "network", "secrets", "shell"])
  assert.equal(requests.length, 0)
})

test("agent pause overrides full-access mode", async () => {
  const { runtime } = createHarness("full-access")
  await runtime.setAgentAccessPaused(true)

  await assert.rejects(
    () => runtime.authorize({ toolName: "file_read", argumentsValue: { filePath: "a.txt" } }),
    (error: unknown) => error instanceof ToolError && error.code === "AGENT_ACCESS_PAUSED"
  )
})
