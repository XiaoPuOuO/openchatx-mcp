import { randomUUID } from "node:crypto"

import { getAgentIdentity } from "../agent/context.js"
import type { AgentObserver } from "../agent/observer.js"
import type { McpServerFactory } from "../mcp/server-factory.js"
import type { RuntimeControlService } from "../runtime/runtime-control.js"
import { type AgentFunctionCall, type AgentMessage, generateAgentTurn } from "./agent-provider.js"
import { openSubagentTools } from "./agent-tool-bridge.js"
import type { SubagentModelProfile, SubagentProviderConfig } from "./config.js"
import type { SubagentRunInput, SubagentRunResult } from "./runtime.js"
import { type SessionRecord, SubagentSessionStore } from "./session-store.js"

// Keep a separate global safety cap; per-parent slots are controlled by config.
const MAX_ACTIVE = 32
const MAX_EVENT_TEXT = 64_000
const MAX_STEPS = 48

export type SubagentStatus = "running" | "completed" | "failed"
export type SubagentEventRole = "user" | "assistant" | "tool" | "guidance"
export interface SubagentEvent {
  id: string
  role: SubagentEventRole
  text: string
  time: string
  status?: "running" | "completed" | "failed" | "queued" | "delivered"
  tool?: string
  input?: string
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
  result?: SubagentRunResult
  error?: string
  pending_guidance: number
}
export type SubagentSessionSummary = Omit<
  SubagentSessionSnapshot,
  "events" | "result" | "error" | "session_id" | "depth"
>
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
  approvalScopes?: Pick<RuntimeControlService, "registerAgentParent" | "clearAgentScope">
  tools: McpServerFactory
  observer: AgentObserver
  resolveProfile: (id: string) => {
    profile: SubagentModelProfile
    provider: SubagentProviderConfig
  }
  apiKey: (provider: SubagentProviderConfig, id: string) => Promise<string | undefined>
}

export class SubagentSessions {
  private readonly active = new Map<string, RunningSession>()
  private readonly store: SubagentSessionStore

  constructor(
    private readonly services: SessionServices,
    dbPath: string
  ) {
    this.store = new SubagentSessionStore(dbPath)
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
      ...(item.result ? { result: item.result } : {}),
      ...(item.error ? { error: item.error } : {}),
    }
  }

  /** Remove the complete tree once its owning ChatGPT conversation is deleted. */
  removeOwnerSession(owner: string): number {
    const records = this.store.list().filter((item) => item.root_owner === owner)
    this.stopSessions(records, "Parent ChatGPT session was removed.")
    return this.store.deleteOwner(owner).length
  }

  /** A deleted job releases its parent's slot; descendants are removed with it. */
  deleteSession(id: string, owner?: string): number {
    const item = this.requireSession(id)
    if (owner !== undefined) this.assertOwner(item, owner)
    const ids = new Set(this.store.subtreeIds(id))
    const records = this.store.list().filter((entry) => ids.has(entry.job_id))
    this.stopSessions(records, "Subagent session was deleted.")
    return this.store.deleteSubtree(id).length
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
    }
  }

  async run(input: SubagentRunInput, signal?: AbortSignal): Promise<SubagentRunResult> {
    const owner = getAgentIdentity()?.sessionId ?? "unscoped"
    const session = this.create(input, owner)
    await this.execute(session, signal)
    if (!session.result) throw new Error(session.error ?? "Subagent did not finish.")
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
      bootstrapped: false,
      notified: false,
      messages: [
        { role: "system", content: this.instructions(input.system) },
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

  private instructions(extra?: string): string {
    return [
      "You are a full OpenChatX subagent. Work autonomously toward the delegated task.",
      "You have the same enabled OpenChatX tool surface and user approval boundaries as other agents.",
      "Use tool_search/tool_call for dynamically exposed capabilities when needed.",
      "You may delegate bounded independent tasks with subagent_run, and retrieve them with subagent_get.",
      "If new Human guidance arrives, incorporate it in your ongoing plan before proceeding.",
      "Do not stop after only describing a plan when tools are needed to accomplish the request.",
      "When complete, provide a concise result including material limitations.",
      ...(extra ? [extra] : []),
    ].join("\n")
  }

  private save(session: RunningSession): void {
    if (session.cancelled) return
    session.updated_at = new Date().toISOString()
    this.store.save(session)
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
      for (let step = 0; step < MAX_STEPS; step += 1) {
        if (session.cancelled) return
        if (combined.aborted) throw combined.reason ?? new Error("Subagent interrupted.")
        if (await this.processTurn(session, tools, provider, profile, apiKey, combined)) return
      }
      throw new Error(`Subagent exceeded ${MAX_STEPS} reasoning/tool steps.`)
    } catch (error) {
      if (!session.cancelled) this.fail(session, error)
    } finally {
      await tools?.close()
      this.finishExecution(session)
    }
  }

  private async prepareTools(session: RunningSession) {
    const tools = await openSubagentTools(
      this.services.tools,
      this.services.observer,
      {
        sessionId: session.session_id,
        profileId: session.profile,
        projectId: session.projectId,
        projectRouting: session.projectRouting,
        projectExternalAccessAll: session.projectExternalAccessAll,
      },
      !session.bootstrapped
    )
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
    const textEvent = this.event(session, { role: "assistant", text: "", status: "running" })
    let lastPersisted = 0
    const completion = await generateAgentTurn({
      provider,
      providerId: profile.provider,
      profile,
      messages: session.messages,
      tools: tools.specs,
      apiKey,
      signal,
      onText: (delta) => {
        if (session.cancelled) return
        textEvent.text = (textEvent.text + delta).slice(0, MAX_EVENT_TEXT)
        if (Date.now() - lastPersisted >= 500) {
          this.store.updateEvent(textEvent)
          lastPersisted = Date.now()
        }
      },
    })
    if (session.cancelled) return true
    textEvent.text = completion.text.slice(0, MAX_EVENT_TEXT)
    textEvent.status = "completed"
    this.store.updateEvent(textEvent)
    const message: AgentMessage = {
      role: "assistant",
      content: completion.text,
      ...(completion.calls.length ? { calls: completion.calls } : {}),
      ...(completion.rawOutput ? { rawOutput: completion.rawOutput } : {}),
    }
    session.messages.push(message)
    this.store.appendMessage(session.job_id, message)
    if (completion.calls.length) {
      for (const call of completion.calls) {
        if (signal.aborted) throw signal.reason ?? new Error("Subagent interrupted.")
        if (session.cancelled) return true
        await this.runTool(session, tools, call, signal)
      }
      return false
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
    return true
  }

  private async runTool(
    session: RunningSession,
    tools: Awaited<ReturnType<typeof openSubagentTools>>,
    call: AgentFunctionCall,
    signal: AbortSignal
  ): Promise<void> {
    const event = this.event(session, {
      role: "tool",
      tool: call.name,
      text: call.name,
      input: safeToolArguments(call.arguments),
      status: "running",
    })
    const result = await tools.call(call, signal)
    if (session.cancelled) return
    event.status = result.failed ? "failed" : "completed"
    event.text = result.displayText ?? result.text
    this.store.updateEvent(event)
    const message: AgentMessage = {
      role: "tool",
      content: result.text,
      callId: call.id,
      name: call.name,
    }
    session.messages.push(message)
    this.store.appendMessage(session.job_id, message)
    this.save(session)
  }
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
