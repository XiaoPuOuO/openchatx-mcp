import { randomUUID } from "node:crypto"

import { getAgentIdentity } from "../agent/context.js"
import type { AgentObserver } from "../agent/observer.js"
import type { McpServerFactory } from "../mcp/server-factory.js"
import type { RuntimeControlService } from "../runtime/runtime-control.js"
import {
  buildCompactedContext,
  contextCompactionDue,
  splitForCompaction,
} from "./agent-compaction.js"
import { type SubagentFileSnapshot, SubagentFileSnapshots } from "./agent-file-snapshots.js"
import type { SubagentHookRegistry } from "./agent-hooks.js"
import type {
  AgentCompletion,
  AgentFunction,
  AgentFunctionCall,
  AgentMessage,
  generateAgentTurn,
} from "./agent-provider.js"
import { isTransientModelError } from "./agent-recovery.js"
import { generateWithRecovery, MAX_MODEL_RETRIES } from "./agent-request-recovery.js"
import { overrideSubagentProfile, subagentModeInstructions } from "./agent-run-options.js"
import { openSubagentTools } from "./agent-tool-bridge.js"
import type { SubagentModelProfile, SubagentProviderConfig } from "./config.js"
import type { SubagentRunInput, SubagentRunResult } from "./runtime.js"
import { type SessionRecord, SubagentSessionStore } from "./session-store.js"

// Keep a separate global safety cap; per-parent slots are controlled by config.
const MAX_ACTIVE = 32
const MAX_EVENT_TEXT = 64_000
const STEP_SEGMENT = 48
const MAX_PARALLEL_READ_TOOLS = 8
const REPEATED_TOOL_BATCH_LIMIT = 3

export type SubagentStatus = "running" | "completed" | "failed" | "stopped"
export type SubagentEventRole = "user" | "assistant" | "tool" | "guidance" | "thinking" | "harness"
export interface SubagentEvent {
  id: string
  role: SubagentEventRole
  text: string
  time: string
  status?: "running" | "completed" | "failed" | "stopped" | "queued" | "delivered"
  tool?: string
  input?: string
  reasoningTokens?: number
  parallelBatch?: string
  durationMs?: number
  action?: "compaction" | "retry" | "loop" | "snapshot"
}
export interface SubagentSessionSnapshot {
  job_id: string
  session_id: string
  profile: string
  provider: string
  model: string
  title: string
  parent_id?: string
  owner_agent_id?: string
  worker_agent_id?: string
  depth: number
  status: SubagentStatus
  created_at: string
  updated_at: string
  events: SubagentEvent[]
  snapshots?: SubagentFileSnapshot[]
  result?: SubagentRunResult
  error?: string
  pending_guidance: number
  modelTurns: number
  active_turns?: number
  active_profile?: string
  compactions: number
  retry?: { attempt: number; reason: string; nextAt: string }
  contextWindow?: number
  usage?: SubagentTokenUsage
  plan?: SubagentPlanStep[]
}
export type SubagentSessionSummary = Omit<
  SubagentSessionSnapshot,
  "events" | "snapshots" | "active_turns" | "result" | "error" | "session_id" | "depth"
>
export interface SubagentPlanStep {
  description: string
  status: "pending" | "in_progress" | "completed" | "blocked"
}

export interface SubagentTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  lastInputTokens?: number
}

export interface SubagentRunJob {
  job_id: string
  profile: string
  status: SubagentStatus
  created_at: string
  updated_at: string
  result?: SubagentRunResult
  error?: string
}
interface PendingGuidance {
  id: string
  message: string
}
/** Only currently executing sessions occupy memory. All history lives on disk. */
interface RunningSession extends SessionRecord {
  messages: AgentMessage[]
  guidance: PendingGuidance[]
  executing: boolean
  cancelled: boolean
  controller: AbortController
}
interface SessionServices {
  limits: () => { max_depth: number; max_children_per_agent: number }
  approvalScopes?: Pick<
    RuntimeControlService,
    "registerAgentParent" | "clearAgentScope" | "approveSubagentTool"
  >
  hooks?: SubagentHookRegistry
  tools: McpServerFactory
  observer: AgentObserver
  projectRoot?: (id: string) => Promise<string | undefined>
  resolveProfile: (id: string) => {
    profile: SubagentModelProfile
    provider: SubagentProviderConfig
  }
  apiKey: (provider: SubagentProviderConfig, id: string) => Promise<string | undefined>
}

export class SubagentSessions {
  private readonly active = new Map<string, RunningSession>()
  private readonly subscribers = new Set<(id: string) => void>()
  private readonly snapshots = new SubagentFileSnapshots()
  private readonly store: SubagentSessionStore

  constructor(
    private readonly services: SessionServices,
    dbPath: string
  ) {
    this.store = new SubagentSessionStore(dbPath)
  }

  subscribe(listener: (id: string) => void): () => void {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  private changed(id: string): void {
    for (const listener of this.subscribers) listener(id)
  }

  list(): SubagentSessionSummary[] {
    return this.store
      .list()
      .map((item) => this.summary(item))
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
  }

  snapshot(id: string): SubagentSessionSnapshot {
    const item = this.requireSession(id)
    return {
      ...this.summary(item),
      session_id: item.session_id,
      depth: item.depth,
      events: this.store.events(id),
      active_turns: this.store.messages(id).filter((message) => message.role === "assistant")
        .length,
      snapshots: this.snapshots.list(id),
      ...(item.result ? { result: item.result } : {}),
      ...(item.error ? { error: item.error } : {}),
    }
  }

  /** Only the live subagent may update its own plan via the MCP tool. */
  updateAgentPlan(sessionId: string, steps: SubagentPlanStep[]): SubagentSessionSnapshot {
    const session = [...this.active.values()].find((entry) => entry.session_id === sessionId)
    if (!session || session.cancelled || !session.executing)
      throw new Error("A running Subagent session is required to update the plan.")
    session.plan = steps.map((step) => ({ ...step }))
    this.save(session)
    return this.snapshot(session.job_id)
  }

  /** Remove the complete tree once its owning ChatGPT conversation is deleted. */
  removeOwnerSession(owner: string): number {
    const records = this.store.list().filter((item) => item.root_owner === owner)
    this.stopSessions(records, "Parent ChatGPT session was removed.")
    const count = this.store.deleteOwner(owner).length
    for (const record of records) {
      this.snapshots.delete(record.job_id)
      this.changed(record.job_id)
    }
    return count
  }

  /** Stop live work without deleting history or releasing the assigned slot. */
  stopSession(id: string, owner?: string): SubagentSessionSnapshot {
    const target = this.requireSession(id)
    if (owner !== undefined) this.assertOwner(target, owner)
    const ids = this.store.subtreeIds(id)
    for (const jobId of ids) {
      const record = this.store.get(jobId)
      if (record?.status !== "running") continue
      const running = this.active.get(jobId)
      if (running) {
        running.cancelled = true
        running.status = "stopped"
        running.controller.abort(new Error("Subagent stopped by user."))
        running.guidance.length = 0
        this.active.delete(jobId)
      }
      record.status = "stopped"
      record.pending_guidance = 0
      record.notified = false
      record.updated_at = new Date().toISOString()
      this.store.save(record)
      this.changed(jobId)
      for (const event of this.store.events(jobId)) {
        if (event.status === "running" || event.status === "queued")
          this.store.updateEvent({ ...event, status: "stopped" })
      }
    }
    return this.snapshot(id)
  }

  /** A deleted job releases its parent's slot; descendants are removed with it. */
  deleteSession(id: string, owner?: string): number {
    const item = this.requireSession(id)
    if (owner !== undefined) this.assertOwner(item, owner)
    const ids = new Set(this.store.subtreeIds(id))
    const records = this.store.list().filter((entry) => ids.has(entry.job_id))
    this.stopSessions(records, "Subagent session was deleted.")
    const count = this.store.deleteSubtree(id).length
    for (const jobId of ids) this.snapshots.delete(jobId)
    this.changed(id)
    return count
  }

  private stopSessions(records: SessionRecord[], reason: string): void {
    const agents = this.services.observer.listAgents()
    for (const item of records) {
      this.services.approvalScopes?.clearAgentScope(item.session_id)
      const running = this.active.get(item.job_id)
      if (running) {
        running.cancelled = true
        running.controller.abort(new Error(reason))
        this.active.delete(item.job_id)
      }
      for (const agent of agents) {
        if (this.services.observer.sessionIdForAgent(agent.id) === item.session_id)
          this.services.observer.deleteAgent(agent.id)
      }
    }
  }

  close(): void {
    for (const item of this.active.values()) {
      item.cancelled = true
      item.controller.abort(new Error("OpenChatX is shutting down."))
    }
    this.active.clear()
    for (const item of this.store.list())
      this.services.approvalScopes?.clearAgentScope(item.session_id)
    this.store.dispose()
  }

  private summary(session: SessionRecord): SubagentSessionSummary {
    const worker = this.services.observer
      .listAgents()
      .find((agent) => this.services.observer.sessionIdForAgent(agent.id) === session.session_id)
    return {
      job_id: session.job_id,
      profile: session.profile,
      provider: session.provider,
      model: session.model,
      title: session.title,
      ...(session.parent_id ? { parent_id: session.parent_id } : {}),
      ...(session.ownerAgentId ? { owner_agent_id: session.ownerAgentId } : {}),
      ...(worker ? { worker_agent_id: worker.id } : {}),
      status: session.status,
      created_at: session.created_at,
      updated_at: session.updated_at,
      pending_guidance: session.pending_guidance,
      modelTurns: session.modelTurns ?? 0,
      ...(session.active_profile ? { active_profile: session.active_profile } : {}),
      compactions: session.compactions ?? 0,
      ...(session.retry ? { retry: session.retry } : {}),
      ...(session.contextWindow ? { contextWindow: session.contextWindow } : {}),
      ...(session.usage ? { usage: session.usage } : {}),
      ...(session.plan ? { plan: session.plan } : {}),
    }
  }

  async run(input: SubagentRunInput, signal?: AbortSignal): Promise<SubagentRunResult> {
    const owner = getAgentIdentity()?.sessionId ?? "unscoped"
    const session = this.create(input, owner)
    await this.execute(session, signal)
    if (!session.result)
      throw new Error(
        session.status === "stopped"
          ? "Subagent stopped by user."
          : (session.error ?? "Subagent did not finish.")
      )
    return session.result
  }

  startAsync(input: SubagentRunInput, owner: string): SubagentRunJob {
    const session = this.create(input, owner)
    void this.execute(session)
    return publicJob(session)
  }

  getJob(id: string, owner: string): SubagentRunJob {
    const item = this.requireSession(id)
    this.assertOwner(item, owner)
    if (item.status !== "running" && !item.notified) {
      item.notified = true
      const running = this.active.get(id)
      if (running) running.notified = true
      this.store.save(item)
    }
    return publicJob(item)
  }

  steer(id: string, message: string, owner?: string): SubagentSessionSnapshot {
    const item = this.requireSession(id)
    if (owner !== undefined) this.assertOwner(item, owner)
    const trimmed = message.trim()
    if (!trimmed || trimmed.length > 8_000) throw new Error("Guidance must be 1–8000 characters.")
    let session = this.active.get(id)
    if (!session) {
      session = this.restore(item)
      this.active.set(id, session)
    }
    const guidanceId = randomUUID()
    this.event(session, {
      id: guidanceId,
      role: "guidance",
      text: trimmed,
      time: new Date().toISOString(),
      status: "queued",
    })
    session.guidance.push({ id: guidanceId, message: trimmed })
    session.pending_guidance = session.guidance.length
    if (!session.executing) {
      session.status = "running"
      session.result = undefined
      session.error = undefined
      session.notified = false
    }
    this.save(session)
    if (!session.executing) void this.execute(session)
    return this.snapshot(id)
  }

  async restoreSnapshot(
    id: string,
    snapshotId: string,
    operation: "undo" | "redo",
    owner?: string
  ): Promise<SubagentSessionSnapshot> {
    const record = this.requireSession(id)
    if (owner !== undefined) this.assertOwner(record, owner)
    if (record.status === "running") throw new Error("Stop the Subagent before restoring files.")
    await this.snapshots.restore(id, snapshotId, operation)
    this.event(this.restore(record), {
      role: "harness",
      text: `File snapshot ${snapshotId} ${operation} completed.`,
      action: "snapshot",
      status: "completed",
    })
    this.changed(id)
    return this.snapshot(id)
  }

  renameSession(id: string, title: string, owner?: string): SubagentSessionSnapshot {
    const record = this.requireSession(id)
    if (owner !== undefined) this.assertOwner(record, owner)
    const trimmed = title.trim()
    if (!trimmed || trimmed.length > 110) throw new Error("Session title must be 1–110 characters.")
    record.title = trimmed
    this.store.save(record)
    const running = this.active.get(id)
    if (running) running.title = trimmed
    this.changed(id)
    return this.snapshot(id)
  }

  forkSession(
    id: string,
    message: string,
    owner?: string,
    throughTurn?: number
  ): SubagentSessionSnapshot {
    const original = this.requireSession(id)
    if (owner !== undefined) this.assertOwner(original, owner)
    if (original.status === "running")
      throw new Error("Stop or finish a session before forking it.")
    const history = contextThroughTurn(this.store.messages(id), throughTurn)
    const fork = this.create(
      {
        profileId: original.profile,
        task: message.trim() || "Continue this session from its saved context.",
        thinking: original.overrides?.thinking,
        thinkingEffort: original.overrides?.thinkingEffort,
        maxOutputTokens: original.overrides?.maxOutputTokens,
      },
      original.root_owner
    )
    const copied = history.map((item) => ({ ...item }))
    copied.push({
      role: "user",
      content: `This is a separate fork of session ${id}. ${message.trim() || "Continue from its checkpoint."} Do not repeat completed side effects.`,
    })
    fork.messages = copied
    this.store.replaceActiveContext(fork.job_id, copied)
    fork.title = `Fork: ${original.title}`.slice(0, 110)
    fork.projectId = original.projectId
    fork.projectRouting = original.projectRouting
    fork.projectExternalAccessAll = original.projectExternalAccessAll
    fork.ownerAgentId = original.ownerAgentId
    fork.active_profile = original.active_profile ?? original.profile
    if (fork.active_profile !== original.profile) {
      const selected = this.services.resolveProfile(fork.active_profile)
      fork.model = selected.profile.model
      fork.provider = selected.profile.provider
    }
    this.save(fork)
    void this.execute(fork)
    return this.snapshot(fork.job_id)
  }

  exportSession(
    id: string,
    owner?: string
  ): { session: SubagentSessionSnapshot; messages: AgentMessage[] } {
    const record = this.requireSession(id)
    if (owner !== undefined) this.assertOwner(record, owner)
    return { session: this.snapshot(id), messages: this.store.messages(id) }
  }

  drainNotifications(owner: string): string[] {
    const messages: string[] = []
    for (const item of this.store.list()) {
      if (item.owner !== owner || item.notified || item.status === "running") continue
      item.notified = true
      const running = this.active.get(item.job_id)
      if (running) running.notified = true
      this.store.save(item)
      messages.push(
        `Subagent job ${item.job_id} ${item.status}. Call subagent_get with job_id="${item.job_id}" to retrieve the result.`
      )
    }
    return messages
  }

  private requireSession(id: string): SessionRecord {
    const session = this.store.get(id)
    if (!session) throw new Error(`Unknown subagent session ${JSON.stringify(id)}.`)
    return session
  }

  private assertOwner(session: SessionRecord, owner: string): void {
    let current: SessionRecord | undefined = session
    while (current) {
      if (current.owner === owner) return
      current = current.parent_id ? this.store.get(current.parent_id) : undefined
    }
    throw new Error("Subagent job not found for this conversation.")
  }

  private create(input: SubagentRunInput, requestedOwner: string): RunningSession {
    const { profile } = this.services.resolveProfile(input.profileId)
    overrideSubagentProfile(profile, input)
    const identity = getAgentIdentity()
    const parent = [...this.active.values()].find(
      (entry) => entry.session_id === identity?.sessionId
    )
    const depth = (parent?.depth ?? 0) + 1
    const limits = this.services.limits()
    if (depth > limits.max_depth)
      throw new Error(
        `Subagent nesting limit reached: maximum ${limits.max_depth} levels (ChatGPT is level 0).`
      )
    const rootOwner = parent?.root_owner ?? requestedOwner
    const usedSlots = this.store.countDirectChildren(parent?.job_id, rootOwner)
    if (usedSlots >= limits.max_children_per_agent)
      throw new Error(
        `Subagent slots full: ${usedSlots}/${limits.max_children_per_agent}. Reuse an existing job with subagent_steer, or delete one with subagent_delete to free a slot.`
      )
    if ([...this.active.values()].filter((entry) => entry.executing).length >= MAX_ACTIVE)
      throw new Error("Too many concurrent subagent sessions.")
    const now = new Date().toISOString()
    const session: RunningSession = {
      job_id: `subagent-${randomUUID()}`,
      session_id: `subagent-session-${randomUUID()}`,
      profile: input.profileId,
      provider: profile.provider,
      model: profile.model,
      title: input.task.split("\n")[0]?.trim().slice(0, 110) || profile.model,
      ...(parent ? { parent_id: parent.job_id } : {}),
      root_owner: rootOwner,
      depth,
      owner: requestedOwner,
      ownerAgentId: parent?.ownerAgentId ?? identity?.agent,
      projectId: identity?.projectRouting ? identity.projectId : parent?.projectId,
      projectRouting: identity?.projectRouting ?? parent?.projectRouting,
      ...(identity?.projectExternalAccessAll || parent?.projectExternalAccessAll
        ? { projectExternalAccessAll: true }
        : {}),
      status: "running",
      created_at: now,
      updated_at: now,
      pending_guidance: 0,
      modelTurns: 0,
      active_profile: input.profileId,
      overrides: {
        ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
        ...(input.thinkingEffort ? { thinkingEffort: input.thinkingEffort } : {}),
        ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
      },
      compactions: 0,
      ...(profile.context_window ? { contextWindow: profile.context_window } : {}),
      bootstrapped: false,
      notified: false,
      messages: [
        {
          role: "system",
          content: this.instructions(subagentModeInstructions(profile), input.system),
        },
        { role: "user", content: input.task },
      ],
      guidance: [],
      executing: false,
      cancelled: false,
      controller: new AbortController(),
    }
    this.store.create(session, session.messages)
    this.services.approvalScopes?.registerAgentParent(session.session_id, requestedOwner)
    this.active.set(session.job_id, session)
    this.event(session, { role: "user", text: input.task })
    return session
  }

  private restore(record: SessionRecord): RunningSession {
    return {
      ...record,
      messages: this.store.messages(record.job_id),
      guidance: [],
      executing: false,
      cancelled: false,
      controller: new AbortController(),
    }
  }

  private instructions(modeInstructions: string, extra?: string): string {
    return [
      "You are a full OpenChatX subagent. Work autonomously toward the delegated task.",
      "You have the same enabled OpenChatX tool surface and user approval boundaries as other agents.",
      "The harness assigns you a stable UUID v4 in your initial start_here response. Remember that exact UUID and include the same agent_id on every OpenChatX tool call and every later start_here call. Never reuse the parent Agent UUID or generate a replacement.",
      "Use tool_search/tool_call for dynamically exposed capabilities when needed.",
      "For every new delegated task, search task-relevant Skills before normal work: use skill_search action=search, then load an exact returned name with action=load. If no Skill applies, explicitly select action=load and omit name. If the user explicitly forbids Skills, use action=load with reason=user-forbids-skills and omit name without searching. If skill_search is not present in your tool list, continue without a Skill. The runtime blocks other tools until this choice is made.",
      "For multi-step work, publish and update a concise plan with subagent_plan.",
      "Issue independent read-only tool calls together; they run concurrently. Write-capable tools execute in order.",
      "You may delegate bounded independent tasks with subagent_run, and retrieve them with subagent_get.",
      "If new Human guidance arrives, incorporate it in your ongoing plan before proceeding.",
      "Do not stop after only describing a plan when tools are needed to accomplish the request.",
      "When complete, provide a concise result including material limitations.",
      ...(modeInstructions ? [modeInstructions] : []),
      ...(extra ? [extra] : []),
    ].join("\n")
  }

  private save(session: RunningSession): void {
    if (session.cancelled) return
    session.updated_at = new Date().toISOString()
    this.store.save(session)
    this.changed(session.job_id)
  }

  private event(
    session: RunningSession,
    item: Omit<SubagentEvent, "id" | "time"> & Partial<Pick<SubagentEvent, "id" | "time">>
  ): SubagentEvent {
    const value: SubagentEvent = {
      id: item.id ?? randomUUID(),
      time: item.time ?? new Date().toISOString(),
      role: item.role,
      text: item.text.slice(0, MAX_EVENT_TEXT),
      ...(item.status ? { status: item.status } : {}),
      ...(item.tool ? { tool: item.tool } : {}),
      ...(item.input ? { input: item.input.slice(0, MAX_EVENT_TEXT) } : {}),
      ...(item.reasoningTokens !== undefined ? { reasoningTokens: item.reasoningTokens } : {}),
      ...(item.parallelBatch ? { parallelBatch: item.parallelBatch } : {}),
      ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
      ...(item.action ? { action: item.action } : {}),
    }
    this.store.addEvent(session.job_id, value)
    this.save(session)
    return value
  }

  private deliverGuidance(session: RunningSession): void {
    for (const item of session.guidance.splice(0)) {
      const existing = this.store.event(item.id)
      if (existing) this.store.updateEvent({ ...existing, status: "delivered" })
      const message: AgentMessage = { role: "user", content: `Human guidance: ${item.message}` }
      session.messages.push(message)
      this.store.appendMessage(session.job_id, message)
    }
    session.pending_guidance = 0
    this.save(session)
  }

  private async execute(session: RunningSession, signal?: AbortSignal): Promise<void> {
    if (session.executing || session.cancelled) return
    session.executing = true
    session.status = "running"
    this.save(session)
    let tools: Awaited<ReturnType<typeof openSubagentTools>> | undefined
    try {
      const { provider, profile } = this.services.resolveProfile(session.profile)
      tools = await this.prepareTools(session)
      if (session.cancelled) return
      const apiKey = await this.services.apiKey(provider, profile.provider)
      const combined = signal
        ? AbortSignal.any([signal, session.controller.signal])
        : session.controller.signal
      await this.executeSteps(session, tools, profile, apiKey, combined)
    } catch (error) {
      if (!session.cancelled) this.fail(session, error)
    } finally {
      await tools?.close()
      this.finishExecution(session)
    }
  }

  private async executeSteps(
    session: RunningSession,
    tools: Awaited<ReturnType<typeof openSubagentTools>>,
    primary: SubagentModelProfile,
    originalKey: string | undefined,
    signal: AbortSignal
  ): Promise<void> {
    for (let step = 0; step < primary.max_steps; step += 1) {
      if (session.cancelled) return
      if (signal.aborted) throw signal.reason ?? new Error("Subagent interrupted.")
      const activeId = session.active_profile ?? session.profile
      const selected = this.services.resolveProfile(activeId)
      const profile = overrideSubagentProfile(
        selected.profile,
        activeId === session.profile ? (session.overrides ?? {}) : {}
      )
      const key =
        activeId === session.profile
          ? originalKey
          : await this.services.apiKey(selected.provider, profile.provider)
      if (await this.processTurn(session, tools, selected.provider, profile, key, signal)) return
      if ((step + 1) % STEP_SEGMENT === 0) {
        this.event(session, {
          role: "harness",
          text: `Continuing after ${step + 1} model steps.`,
          status: "completed",
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    throw new Error(`Subagent reached the configured ${primary.max_steps} step safety limit.`)
  }

  private async prepareTools(session: RunningSession) {
    const projectRoot = session.projectId
      ? await this.services.projectRoot?.(session.projectId)
      : undefined
    let prepared: Awaited<ReturnType<typeof openSubagentTools>> | undefined
    const tools = await openSubagentTools(
      this.services.tools,
      this.services.observer,
      {
        sessionId: session.session_id,
        profileId: session.profile,
        agentId: session.session_id.startsWith("subagent-session-")
          ? session.session_id.slice("subagent-session-".length)
          : undefined,
        projectId: session.projectId,
        projectRouting: session.projectRouting,
        projectExternalAccessAll: session.projectExternalAccessAll,
        projectRoot,
        policy: this.services.resolveProfile(session.profile).profile,
        onProgramStep: async (call, signal) => {
          if (!prepared) throw new Error("Subagent tools are not ready.")
          const executed = await this.runTool(
            session,
            prepared,
            call,
            signal ?? session.controller.signal
          )
          if (!executed) return { failed: true, text: "Subagent stopped." }
          return {
            text: executed.message.content,
            failed: executed.failed,
            ...(executed.message.attachments ? { attachments: executed.message.attachments } : {}),
          }
        },
        ...(this.services.approvalScopes
          ? {
              approveTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
                this.services.approvalScopes?.approveSubagentTool(name, args, signal) ??
                Promise.resolve(),
            }
          : {}),
      },
      !session.bootstrapped
    )
    prepared = tools
    try {
      if (
        !session.cancelled &&
        tools.bootstrapInstructions &&
        session.messages[0]?.role === "system"
      ) {
        session.messages[0].content += `\n\n${tools.bootstrapInstructions}`
        this.store.replaceFirstMessage(session.job_id, session.messages[0])
      }
      if (!session.cancelled) {
        session.bootstrapped = true
        this.save(session)
      }
      return tools
    } catch (error) {
      await tools.close()
      throw error
    }
  }

  private fail(session: RunningSession, error: unknown): void {
    if (error instanceof Error) session.error = error.message
    else if (typeof error === "string") session.error = error
    else session.error = "Subagent execution failed."
    session.status = "failed"
    this.event(session, { role: "assistant", text: session.error, status: "failed" })
    void this.services.hooks?.emit({
      type: "onError",
      sessionId: session.session_id,
      jobId: session.job_id,
      error: session.error,
    })
  }

  private finishExecution(session: RunningSession): void {
    session.executing = false
    if (session.cancelled) return
    this.save(session)
    if (session.guidance.length && session.status !== "running") {
      session.result = undefined
      session.error = undefined
      session.notified = false
      void this.execute(session)
    } else {
      this.active.delete(session.job_id)
    }
  }

  private async processTurn(
    session: RunningSession,
    tools: Awaited<ReturnType<typeof openSubagentTools>>,
    provider: SubagentProviderConfig,
    profile: SubagentModelProfile,
    apiKey: string | undefined,
    signal: AbortSignal
  ): Promise<boolean> {
    this.deliverGuidance(session)
    await this.compactContext(session, {
      provider,
      profile,
      apiKey,
      signal,
      tools: tools.specs,
      force: false,
    })
    let completion: AgentCompletion
    try {
      completion = await this.generateTurn(session, tools, provider, profile, apiKey, signal)
    } catch (error) {
      if (!isTransientModelError(error) || this.hasPartialAssistantOutput(session)) throw error
      const primary = this.services.resolveProfile(session.profile).profile
      const fallbackIndex = primary.fallback_models.indexOf(
        session.active_profile ?? session.profile
      )
      const candidates = primary.fallback_models.slice(fallbackIndex + 1)
      const next = candidates.find((id) => {
        try {
          this.services.resolveProfile(id)
          return true
        } catch {
          return false
        }
      })
      if (!next) throw error
      session.active_profile = next
      const selected = this.services.resolveProfile(next)
      session.model = selected.profile.model
      session.provider = selected.profile.provider
      // Native signed reasoning blocks cannot be carried to a different provider.
      if (selected.provider.type !== provider.type) {
        session.messages = session.messages.map((entry) =>
          entry.role === "assistant" ? { ...entry, rawOutput: undefined } : entry
        )
        this.store.replaceActiveContext(session.job_id, session.messages)
      }
      this.event(session, {
        role: "harness",
        text: `Provider failover: ${profile.provider} → ${selected.profile.provider} (${selected.profile.model})`,
        status: "completed",
      })
      return false
    }
    if (session.cancelled) return true
    session.modelTurns = (session.modelTurns ?? 0) + 1
    if (completion.usage) session.usage = accumulateTokenUsage(session.usage, completion.usage)
    this.save(session)
    const message: AgentMessage = {
      role: "assistant",
      content: completion.text,
      ...(completion.calls.length ? { calls: completion.calls } : {}),
      ...(completion.rawOutput ? { rawOutput: completion.rawOutput } : {}),
    }
    session.messages.push(message)
    this.store.appendMessage(session.job_id, message)
    if (completion.calls.length) {
      if (isRepeatingToolBatch(session.messages.slice(0, -1), completion.calls)) {
        this.event(session, {
          role: "harness",
          action: "loop",
          status: "failed",
          text: "Repeated identical tool calls detected. Stop the loop and request new guidance.",
        })
        throw new Error("Repeated identical tool calls; execution halted to prevent an agent loop.")
      }
      await this.runTools(session, tools, completion.calls, signal)
      return session.cancelled
    }
    if (session.guidance.length) return false
    session.result = {
      profile: session.profile,
      provider: profile.provider,
      model: profile.model,
      content: completion.text,
      ...(completion.usage ? { usage: completion.usage } : {}),
    }
    session.status = "completed"
    this.save(session)
    await this.services.hooks?.emit({
      type: "onComplete",
      sessionId: session.session_id,
      jobId: session.job_id,
      content: completion.text,
    })
    return true
  }

  private hasPartialAssistantOutput(session: RunningSession): boolean {
    const events = this.store.events(session.job_id)
    const latest = events
      .filter((event) => event.role === "assistant" || event.role === "thinking")
      .slice(-2)
    return latest.some((event) => event.text.length > 0 && event.status === "failed")
  }

  private appendTurnDelta(
    session: RunningSession,
    event: SubagentEvent,
    delta: string,
    lastWrite: number
  ): number {
    if (session.cancelled) return lastWrite
    event.text = (event.text + delta).slice(0, MAX_EVENT_TEXT)
    const now = Date.now()
    if (now - lastWrite < 500) return lastWrite
    this.store.updateEvent(event)
    this.changed(session.job_id)
    return now
  }

  private finalizeTurnEvents(
    session: RunningSession,
    textEvent: SubagentEvent,
    thinkingEvent: SubagentEvent | undefined,
    completion: Awaited<ReturnType<typeof generateAgentTurn>>
  ): void {
    const summaryEvent =
      thinkingEvent ??
      (completion.reasoningSummary || completion.reasoningTokens
        ? this.event(session, { role: "thinking", text: "", status: "completed" })
        : undefined)
    if (summaryEvent) {
      summaryEvent.text = (completion.reasoningSummary ?? summaryEvent.text).slice(
        0,
        MAX_EVENT_TEXT
      )
      if (completion.reasoningTokens !== undefined)
        summaryEvent.reasoningTokens = completion.reasoningTokens
      summaryEvent.status = "completed"
      this.store.updateEvent(summaryEvent)
    }
    textEvent.text = completion.text.slice(0, MAX_EVENT_TEXT)
    textEvent.status = "completed"
    this.store.updateEvent(textEvent)
    this.changed(session.job_id)
  }

  private async compactContext(
    session: RunningSession,
    options: {
      provider: SubagentProviderConfig
      profile: SubagentModelProfile
      apiKey: string | undefined
      signal: AbortSignal
      tools: AgentFunction[]
      force: boolean
    }
  ): Promise<boolean> {
    const { provider, profile, apiKey, signal, tools, force } = options
    if (
      !force &&
      !contextCompactionDue(
        session.messages,
        tools,
        session.contextWindow,
        session.usage?.lastInputTokens
      )
    )
      return false
    if (!splitForCompaction(session.messages, session.contextWindow, force)) return false
    const event = this.event(session, {
      role: "harness",
      action: "compaction",
      status: "running",
      text: "Summarizing older context…",
    })
    try {
      const result = await buildCompactedContext({
        messages: session.messages,
        profile,
        provider,
        apiKey,
        signal,
        ...(session.plan ? { plan: session.plan } : {}),
        force,
      })
      if (session.cancelled || signal.aborted) return false
      if (!result) throw new Error("No earlier context can be summarized.")
      this.store.replaceActiveContext(session.job_id, result.active)
      session.messages = result.active
      session.compactions = (session.compactions ?? 0) + 1
      if (result.usage) session.usage = accumulateTokenUsage(session.usage, result.usage)
      event.status = "completed"
      event.text = `Context checkpoint #${session.compactions}: summarized ${result.previousCount} earlier messages; kept ${result.retained} recent messages.\n\n${result.summary.slice(0, 4000)}`
      this.store.updateEvent(event)
      this.save(session)
      return true
    } catch (error) {
      if (session.cancelled) return false
      event.status = "failed"
      event.text = `Context compaction failed: ${error instanceof Error ? error.message : "Unknown error"}`
      this.store.updateEvent(event)
      return false
    }
  }

  private async requestWithRecovery(
    session: RunningSession,
    options: {
      provider: SubagentProviderConfig
      profile: SubagentModelProfile
      apiKey: string | undefined
      tools: AgentFunction[]
      signal: AbortSignal
      onText: (delta: string) => void
      onReasoningSummary: (delta: string) => void
    }
  ): Promise<AgentCompletion> {
    const { provider, profile, apiKey, tools, signal } = options
    let retryEvent: SubagentEvent | undefined
    return generateWithRecovery({
      ...options,
      providerId: profile.provider,
      messages: () => session.messages,
      compact: () =>
        this.compactContext(session, {
          provider,
          profile,
          apiKey,
          tools,
          signal,
          force: true,
        }),
      onRetry: (info, outcome) => {
        if (session.cancelled) return
        if (info) {
          session.retry = {
            attempt: info.attempt,
            reason: info.reason,
            nextAt: info.nextAt,
          }
          retryEvent ??= this.event(session, {
            role: "harness",
            action: "retry",
            status: "running",
            text: "",
          })
          retryEvent.text = `Retry ${info.attempt}/${MAX_MODEL_RETRIES} in ${Math.ceil(info.delayMs / 1000)}s: ${info.reason}`
          this.store.updateEvent(retryEvent)
        } else {
          session.retry = undefined
          if (retryEvent) {
            retryEvent.status = outcome === "completed" ? "completed" : "failed"
            retryEvent.text =
              outcome === "completed"
                ? "Model request recovered."
                : "Model request exhausted its retries."
            this.store.updateEvent(retryEvent)
          }
        }
        this.save(session)
      },
    })
  }

  private async generateTurn(
    session: RunningSession,
    tools: Awaited<ReturnType<typeof openSubagentTools>>,
    provider: SubagentProviderConfig,
    profile: SubagentModelProfile,
    apiKey: string | undefined,
    signal: AbortSignal
  ): Promise<Awaited<ReturnType<typeof generateAgentTurn>>> {
    const thinkingEnabled = profile.thinking.mode !== "none" && profile.thinking.default_enabled
    const thinkingEvent = thinkingEnabled
      ? this.event(session, { role: "thinking", text: "", status: "running" })
      : undefined
    const textEvent = this.event(session, { role: "assistant", text: "", status: "running" })
    let lastTextWrite = 0
    let lastThinkingWrite = 0
    try {
      const completion = await this.requestWithRecovery(session, {
        provider,
        profile,
        apiKey,
        tools: tools.specs,
        signal,
        onText: (delta) => {
          lastTextWrite = this.appendTurnDelta(session, textEvent, delta, lastTextWrite)
        },
        onReasoningSummary: (delta) => {
          if (!thinkingEvent) return
          lastThinkingWrite = this.appendTurnDelta(session, thinkingEvent, delta, lastThinkingWrite)
        },
      })
      if (!session.cancelled) this.finalizeTurnEvents(session, textEvent, thinkingEvent, completion)
      return completion
    } catch (error) {
      if (!session.cancelled) {
        textEvent.status = "failed"
        this.store.updateEvent(textEvent)
        if (thinkingEvent) {
          thinkingEvent.status = "failed"
          this.store.updateEvent(thinkingEvent)
        }
      }
      throw error
    }
  }

  /**
   * Execute consecutive read-only MCP calls concurrently, but use a sequential
   * barrier before every write-capable or unannotated tool. Model-visible
   * results are appended in the original function-call order.
   */
  private async runTools(
    session: RunningSession,
    tools: Awaited<ReturnType<typeof openSubagentTools>>,
    calls: AgentFunctionCall[],
    signal: AbortSignal
  ): Promise<void> {
    let index = 0
    const mediaMessages: AgentMessage[] = []
    while (index < calls.length && !session.cancelled) {
      if (signal.aborted) throw signal.reason ?? new Error("Subagent interrupted.")
      const first = calls[index]
      if (!first) break
      const readBatch = consecutiveReadOnlyCalls(calls, index, tools.parallelReadOnly)
      const batch = readBatch.length > 0 ? readBatch : [first]
      const batchId = batch.length > 1 ? randomUUID() : undefined
      const replies = await Promise.all(
        batch.map((call) => this.runTool(session, tools, call, signal, batchId))
      )
      if (session.cancelled) return
      // Even when the fifth grep finishes first, its response stays fifth.
      this.appendBatchReplies(
        session,
        replies.map((reply) => reply?.message),
        mediaMessages
      )
      index += batch.length
    }
    // Tool results must precede user media blocks for all calls from one model turn.
    for (const message of mediaMessages) this.appendToolReply(session, message)
  }

  private appendBatchReplies(
    session: RunningSession,
    replies: Array<AgentMessage | undefined>,
    mediaMessages: AgentMessage[]
  ): void {
    for (const reply of replies) {
      if (!reply) continue
      const { attachments, ...toolReply } = reply
      this.appendToolReply(session, toolReply)
      if (attachments?.length)
        mediaMessages.push({
          role: "user",
          content: `Attachments returned by tool ${reply.name ?? "unknown"}:`,
          attachments,
        })
    }
  }

  private appendToolReply(session: RunningSession, message: AgentMessage): void {
    if (session.cancelled) return
    session.messages.push(message)
    this.store.appendMessage(session.job_id, message)
    this.save(session)
  }

  private async runTool(
    session: RunningSession,
    tools: Awaited<ReturnType<typeof openSubagentTools>>,
    call: AgentFunctionCall,
    signal: AbortSignal,
    batchId?: string
  ): Promise<{ message: AgentMessage; failed: boolean } | undefined> {
    const started = Date.now()
    const event = this.event(session, {
      role: "tool",
      tool: call.name,
      text: call.name,
      input: safeToolArguments(call.arguments),
      status: "running",
      ...(batchId ? { parallelBatch: batchId } : {}),
    })
    let text: string
    let streamedOutput = ""
    let attachments: AgentMessage["attachments"]
    try {
      await this.services.hooks?.emit({
        type: "beforeTool",
        sessionId: session.session_id,
        jobId: session.job_id,
        call,
      })
      const projectRoot = session.projectId
        ? await this.services.projectRoot?.(session.projectId)
        : undefined
      const capture = await this.snapshots.capture(session.job_id, projectRoot, call)
      const result = await tools.call(call, signal, (message) => {
        if (session.cancelled) return
        streamedOutput = (streamedOutput + message).slice(-MAX_EVENT_TEXT)
        event.text = `${call.name}\n${streamedOutput}`.slice(-MAX_EVENT_TEXT)
        this.store.updateEvent(event)
        this.changed(session.job_id)
      })
      if (session.cancelled) return undefined
      await this.snapshots.complete(capture)
      event.status = result.failed ? "failed" : "completed"
      event.text = result.displayText ?? result.text
      text = result.text
      attachments = result.attachments
    } catch (error) {
      if (session.cancelled) return undefined
      event.status = "failed"
      text = error instanceof Error ? error.message : "Tool execution failed."
      event.text = text
    }
    event.durationMs = Math.max(0, Date.now() - started)
    this.store.updateEvent(event)
    this.changed(session.job_id)
    await this.services.hooks?.emit({
      type: "afterTool",
      sessionId: session.session_id,
      jobId: session.job_id,
      call,
      failed: event.status === "failed",
      output: text,
    })
    return {
      message: {
        role: "tool",
        content: text,
        callId: call.id,
        name: call.name,
        ...(attachments?.length ? { attachments } : {}),
      },
      failed: event.status === "failed",
    }
  }
}

/**
 * Create a safe model-turn boundary for non-destructive conversation rewind.
 * All tool replies belonging to the selected assistant turn are retained.
 */
export function contextThroughTurn(history: AgentMessage[], throughTurn?: number): AgentMessage[] {
  if (throughTurn === undefined) return history
  const total = history.filter((item) => item.role === "assistant").length
  if (!Number.isSafeInteger(throughTurn) || throughTurn < 0 || throughTurn > total)
    throw new Error(`Choose a model turn between 0 and ${total} in active context.`)
  let count = 0
  const included: AgentMessage[] = []
  for (const message of history) {
    if (message.role === "assistant") {
      count += 1
      if (count > throughTurn) break
    } else if (message.role !== "tool" && count === throughTurn && throughTurn > 0) break
    included.push(message)
  }
  return included
}

function consecutiveReadOnlyCalls(
  calls: AgentFunctionCall[],
  start: number,
  readOnly: ReadonlySet<string>
): AgentFunctionCall[] {
  const batch: AgentFunctionCall[] = []
  for (let i = start; i < calls.length && batch.length < MAX_PARALLEL_READ_TOOLS; i++) {
    const call = calls[i]
    if (!call || !readOnly.has(call.name)) break
    batch.push(call)
  }
  return batch
}

/** Stop repeated identical multi-tool batches before re-executing side effects. */
export function isRepeatingToolBatch(
  history: AgentMessage[],
  calls: AgentFunctionCall[],
  threshold = REPEATED_TOOL_BATCH_LIMIT
): boolean {
  const signature = JSON.stringify(calls.map((call) => [call.name, call.arguments]))
  let repetitions = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i]
    if (item?.role === "user") break
    if (item?.role !== "assistant" || !item.calls?.length) continue
    if (JSON.stringify(item.calls.map((call) => [call.name, call.arguments])) !== signature) break
    repetitions += 1
    if (repetitions >= threshold) return true
  }
  return false
}

function tokenCount(usage: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = usage[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

/** Aggregate only Provider-reported usage; do not estimate missing token counts. */
export function accumulateTokenUsage(
  previous: SubagentTokenUsage | undefined,
  raw: Record<string, unknown>
): SubagentTokenUsage | undefined {
  let input = tokenCount(raw, ["input_tokens", "prompt_tokens", "promptTokenCount"])
  if (input !== undefined && typeof raw.input_tokens === "number") {
    input +=
      (tokenCount(raw, ["cache_read_input_tokens"]) ?? 0) +
      (tokenCount(raw, ["cache_creation_input_tokens"]) ?? 0)
  }
  const output = tokenCount(raw, ["output_tokens", "completion_tokens", "candidatesTokenCount"])
  const total =
    tokenCount(raw, ["total_tokens", "totalTokenCount"]) ??
    (input !== undefined && output !== undefined ? input + output : undefined)
  if (input === undefined && output === undefined && total === undefined) return previous
  const next: SubagentTokenUsage = { ...previous }
  if (input !== undefined) {
    next.inputTokens = (previous?.inputTokens ?? 0) + input
    next.lastInputTokens = input
  }
  if (output !== undefined) next.outputTokens = (previous?.outputTokens ?? 0) + output
  if (total !== undefined) next.totalTokens = (previous?.totalTokens ?? 0) + total
  return next
}

const SECRET_KEY_RE =
  /(?:api[_-]?key|authorization|token|secret|password|cookie|credential|private[_-]?key)/iu

/** Dashboard previews must never echo credential-valued tool arguments. */
export function safeToolArguments(args: Record<string, unknown>): string {
  const scrub = (value: unknown, depth: number): unknown => {
    if (depth > 8) return "[Nested value omitted]"
    if (Array.isArray(value)) return value.map((entry) => scrub(entry, depth + 1))
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          SECRET_KEY_RE.test(key) ? "[redacted]" : scrub(entry, depth + 1),
        ])
      )
    }
    if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      try {
        return JSON.stringify(scrub(JSON.parse(value), depth + 1))
      } catch {
        return value
      }
    }
    return value
  }
  return JSON.stringify(scrub(args, 0)).slice(0, MAX_EVENT_TEXT)
}

function publicJob(session: SessionRecord): SubagentRunJob {
  return {
    job_id: session.job_id,
    profile: session.profile,
    status: session.status,
    created_at: session.created_at,
    updated_at: session.updated_at,
    ...(session.result ? { result: session.result } : {}),
    ...(session.error ? { error: session.error } : {}),
  }
}
