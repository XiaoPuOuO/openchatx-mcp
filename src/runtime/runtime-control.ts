import { AsyncLocalStorage } from "node:async_hooks"

import { ToolError } from "../mcp/tool-error.js"
import { desktopNotificationService } from "../notifications/notification-service.js"
import {
  type AccessMode,
  loadOperationalState,
  type OperationalState,
  updateOperationalState,
} from "../recovery/operational-state.js"
import { type ActionRisk, classifyAction } from "./action-risk.js"
import { ApprovalStore, type RuntimeApproval } from "./approval-store.js"

const TOOL_SHELL_RE = /(?:shell|bash|terminal|exec|command|process)/u
const TOOL_NETWORK_RE = /(?:fetch|http|browser|network|request|download|upload)/u
const TOOL_SECRETS_RE = /(?:secret|token|credential|keychain|password|apikey|api_key)/u

export interface RuntimeToolSource {
  kind: "builtin" | "toolbox" | "mcp"
  id?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  openWorldHint?: boolean
  canonicalToolName?: string
}

export interface RuntimeAuthorizationInput {
  toolName: string
  argumentsValue: Record<string, unknown>
  source?: RuntimeToolSource
  signal?: AbortSignal
}

export type CapabilityPermission = "shell" | "network" | "filesystem" | "secrets"
export type ToolRiskOverride = "low" | "approval"

export interface RuntimeExecutionGrant {
  accessMode: AccessMode
  source?: RuntimeToolSource
  permissions: CapabilityPermission[]
}

export interface RuntimeControlSnapshot {
  accessMode: AccessMode
  agentAccessPaused: boolean
}

type ApprovalStoreLike = Pick<ApprovalStore, "list" | "request" | "decide" | "isApproved">

type RuntimeApprovalDecision = "allow-operation" | "approve-once" | "always-allow" | "deny"
type ApprovalWaitResult = "approved" | "denied"

interface RuntimeStateStore {
  load(): Promise<OperationalState>
  update(
    updater: (state: OperationalState) => OperationalState | undefined
  ): Promise<OperationalState>
}

const DEFAULT_STATE_STORE: RuntimeStateStore = {
  load: loadOperationalState,
  update: updateOperationalState,
}

const executionGrant = new AsyncLocalStorage<RuntimeExecutionGrant>()

export function currentRuntimeExecutionGrant(): RuntimeExecutionGrant | undefined {
  return executionGrant.getStore()
}

export class RuntimeControlService {
  private readonly approvalWaiters = new Map<string, Set<(decision: ApprovalWaitResult) => void>>()

  constructor(
    private readonly approvals: ApprovalStoreLike = new ApprovalStore(),
    private readonly stateStore: RuntimeStateStore = DEFAULT_STATE_STORE
  ) {}

  async snapshot(): Promise<RuntimeControlSnapshot> {
    const state = await this.stateStore.load()
    return {
      accessMode: state.accessMode,
      agentAccessPaused: state.agentAccess.paused,
    }
  }

  async authorize(input: RuntimeAuthorizationInput): Promise<RuntimeExecutionGrant> {
    const state = await this.stateStore.load()
    const source = inferLazySource(input) ?? input.source
    const resolvedInput = source ? { ...input, source } : input

    if (state.agentAccess.paused) {
      throw new ToolError(
        "AGENT_ACCESS_PAUSED",
        "OpenChatX Agent access is paused by the user. Resume Agent access from the OpenChatX UI before retrying."
      )
    }

    if (state.accessMode === "full-access") {
      return {
        accessMode: state.accessMode,
        ...(source ? { source } : {}),
        permissions: ["shell", "network", "filesystem", "secrets"],
      }
    }

    const permissions = resolveRequiredPermissions(state.capabilityPermissions, resolvedInput)
    this.enforceDeniedCapabilityPermissions(state.capabilityPermissions, resolvedInput, permissions)

    const riskKey = runtimeToolRiskKey(resolvedInput)
    const riskOverride = state.toolRiskOverrides[riskKey]
    const risk: ActionRisk = riskOverride
      ? { level: riskOverride }
      : classifyAction(resolvedInput, permissions)
    const category =
      riskOverride === "approval" ? `tool-risk:${riskKey}` : (risk.category ?? "always-question")
    const reason =
      riskOverride === "approval"
        ? "This tool is configured to require approval."
        : (risk.reason ??
          (state.accessMode === "always-question"
            ? "Always Question Mode requires approval for every action."
            : "This action requires approval."))
    const policy = state.dangerousActions[category] ?? "ask"

    if (policy === "deny") throw new ToolError("DANGEROUS_ACTION_DENIED", reason)

    if (state.accessMode === "always-question") {
      await this.requireApproval(resolvedInput, category, reason, false)
    } else if (risk.level === "approval" && policy === "ask") {
      await this.requireApproval(resolvedInput, category, reason)
    }

    return {
      accessMode: state.accessMode,
      ...(source ? { source } : {}),
      permissions,
    }
  }

  runWithGrant<T>(grant: RuntimeExecutionGrant, action: () => T): T {
    return executionGrant.run(grant, action)
  }

  private enforceDeniedCapabilityPermissions(
    policies: Record<string, Record<string, "ask" | "allow" | "deny">>,
    input: RuntimeAuthorizationInput,
    permissions: CapabilityPermission[]
  ): void {
    if (!input.source?.id || permissions.length === 0) return
    const keys = sourcePermissionKeys(input.source)
    const denied = permissions.filter(
      (permission) => firstPermissionPolicy(policies, keys, permission) === "deny"
    )
    if (denied.length > 0) {
      throw new ToolError(
        "CAPABILITY_PERMISSION_DENIED",
        `${input.source.kind} ${input.source.id} is denied: ${denied.join(", ")}.`
      )
    }
  }

  async listApprovals(): Promise<RuntimeApproval[]> {
    return this.approvals.list()
  }

  async decideApproval(id: string, decision: RuntimeApprovalDecision): Promise<RuntimeApproval> {
    const approval = (await this.approvals.list()).find((candidate) => candidate.id === id)
    if (!approval) throw new Error(`Unknown approval ${JSON.stringify(id)}.`)
    if (approval.status !== "pending") {
      throw new Error(`Approval ${JSON.stringify(id)} has already been decided.`)
    }

    if (decision === "approve-once") {
      const result = await this.approvals.decide(id, "dismiss")
      this.resolveApprovalWaiters(id, "approved")
      return result
    }

    if (decision === "allow-operation") {
      const result = await this.approvals.decide(id, "approve")
      this.resolveApprovalWaiters(id, "approved")
      return result
    }

    if (decision === "always-allow") {
      await this.stateStore.update((state) => {
        if (approval.category.startsWith("permissions:") && approval.source?.id) {
          const permissions = approval.category
            .slice("permissions:".length)
            .split(",")
            .filter(isCapabilityPermission)
          const key = `${approval.source.kind}:${approval.source.id}`
          const current = state.capabilityPermissions[key] ?? {}
          state.capabilityPermissions[key] = {
            ...current,
            ...Object.fromEntries(permissions.map((permission) => [permission, "allow"])),
          }
          return
        }
        if (approval.category.startsWith("tool-risk:")) {
          const key = approval.category.slice("tool-risk:".length)
          state.toolRiskOverrides[key] = "low"
          return
        }
        state.dangerousActions[approval.category] = "allow"
      })
      const result = await this.approvals.decide(id, "dismiss")
      this.resolveApprovalWaiters(id, "approved")
      return result
    }

    const result = await this.approvals.decide(id, "deny")
    this.resolveApprovalWaiters(id, "denied")
    return result
  }

  async setAccessMode(mode: AccessMode): Promise<void> {
    await this.stateStore.update((state) => {
      state.accessMode = mode
    })
  }

  async setToolRiskOverride(key: string, risk: ToolRiskOverride | undefined): Promise<void> {
    await this.stateStore.update((state) => {
      if (risk) state.toolRiskOverrides[key] = risk
      else delete state.toolRiskOverrides[key]
      delete state.dangerousActions[`tool-risk:${key}`]
    })
  }

  async setAgentAccessPaused(paused: boolean): Promise<void> {
    await this.stateStore.update((state) => {
      state.agentAccess = paused
        ? { paused: true, pausedAt: new Date().toISOString() }
        : { paused: false }
    })
  }

  private async requireApproval(
    input: RuntimeAuthorizationInput,
    category: string,
    reason: string,
    reuseApproved = true
  ): Promise<void> {
    if (
      reuseApproved &&
      (await this.approvals.isApproved(input.toolName, input.argumentsValue, category))
    )
      return
    const approval = await this.approvals.request({
      toolName: input.toolName,
      category,
      reason,
      argumentsValue: input.argumentsValue,
      ...(input.source ? { source: input.source } : {}),
    })
    await desktopNotificationService
      .notify("approvalRequired", "OpenChatX approval required", reason)
      .catch(() => undefined)
    const decision = await this.waitForApproval(approval.id, input.signal)
    if (decision === "denied") {
      throw new ToolError("APPROVAL_DENIED", `${reason} The user denied this action.`)
    }
  }

  private waitForApproval(id: string, signal?: AbortSignal): Promise<ApprovalWaitResult> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new ToolError("APPROVAL_CANCELLED", "Approval wait was cancelled."))
        return
      }

      let settled = false
      const cleanup = () => {
        const waiters = this.approvalWaiters.get(id)
        waiters?.delete(onDecision)
        if (waiters?.size === 0) this.approvalWaiters.delete(id)
        signal?.removeEventListener("abort", onAbort)
      }
      const onDecision = (decision: ApprovalWaitResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(decision)
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        if (!this.approvalWaiters.has(id)) {
          void this.approvals.decide(id, "dismiss").catch(() => undefined)
        }
        reject(new ToolError("APPROVAL_CANCELLED", "Approval wait was cancelled."))
      }

      const waiters = this.approvalWaiters.get(id) ?? new Set()
      waiters.add(onDecision)
      this.approvalWaiters.set(id, waiters)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  private resolveApprovalWaiters(id: string, decision: ApprovalWaitResult): void {
    for (const waiter of this.approvalWaiters.get(id) ?? []) waiter(decision)
  }
}

function inferLazySource(input: RuntimeAuthorizationInput): RuntimeToolSource | undefined {
  if (input.toolName !== "tool_call") return undefined
  const tool = input.argumentsValue.tool
  if (typeof tool !== "string") return undefined
  if (tool.startsWith("toolbox:")) {
    const parts = tool.split(":")
    return parts.length >= 3
      ? { kind: "toolbox", id: parts[1], canonicalToolName: parts.slice(2).join(":") }
      : undefined
  }
  if (tool.startsWith("mcp:")) {
    const parts = tool.split(":")
    return parts.length >= 3
      ? { kind: "mcp", id: parts[1], canonicalToolName: parts.slice(2).join(":") }
      : undefined
  }
  return { kind: "builtin" }
}

export function runtimeToolRiskKey(input: RuntimeAuthorizationInput): string {
  const source = input.source
  const name = source?.canonicalToolName ?? effectiveToolName(input)
  if (!source || source.kind === "builtin" || !source.id) return `builtin:${name}`
  return `${source.kind}:${source.id}:${name}`
}

function resolveRequiredPermissions(
  policies: Record<string, Record<string, "ask" | "allow" | "deny">>,
  input: RuntimeAuthorizationInput
): CapabilityPermission[] {
  if (!input.source || input.source.kind === "builtin") return []
  const configured = sourcePermissionKeys(input.source)
    .map((key) => policies[key])
    .find((value) => value !== undefined)
  if (configured) {
    return Object.keys(configured).filter(isCapabilityPermission)
  }
  const inferred = requiredCapabilityPermission(input)
  return inferred ? [inferred] : []
}

function isCapabilityPermission(value: string): value is CapabilityPermission {
  return value === "shell" || value === "network" || value === "filesystem" || value === "secrets"
}

function firstPermissionPolicy(
  policies: Record<string, Record<string, "ask" | "allow" | "deny">>,
  keys: string[],
  permission: string
): "ask" | "allow" | "deny" | undefined {
  for (const key of keys) {
    const policy = policies[key]?.[permission]
    if (policy) return policy
  }
  return undefined
}

function sourcePermissionKeys(source: RuntimeToolSource): string[] {
  if (!source.id) return []
  if (source.kind === "toolbox") return [`toolbox:${source.id}`, source.id]
  if (source.kind === "mcp") return [`mcp:${source.id}`, source.id]
  return [source.id]
}

function requiredCapabilityPermission(
  input: RuntimeAuthorizationInput
): "shell" | "network" | "filesystem" | "secrets" | undefined {
  if (!input.source || input.source.kind === "builtin") return undefined
  if (input.source.kind === "mcp") return "network"

  const lowered = effectiveToolName(input).toLowerCase()
  if (TOOL_SECRETS_RE.test(lowered)) return "secrets"
  if (TOOL_SHELL_RE.test(lowered)) return "shell"
  if (TOOL_NETWORK_RE.test(lowered)) return "network"
  return "filesystem"
}

function effectiveToolName(input: RuntimeAuthorizationInput): string {
  if (input.toolName !== "tool_call") return input.toolName
  const tool = input.argumentsValue.tool
  if (typeof tool !== "string") return input.toolName
  const parts = tool.split(":")
  return parts.length >= 3 ? parts.slice(2).join(":") : tool
}
