import type { Browser, BrowserContext, Page } from "playwright-core"

import { MCP_CONFIG } from "../../config.js"
import { asRecord, nonNegativeInteger, positiveInteger } from "../../utils.js"
import {
  assertAuthenticated,
  assertManagedChatGptPage,
  createBackgroundPage,
  delay,
  dismissBlockingChatGptOverlay,
  enterPrompt,
  extractConversationId,
  findComposer,
  isChatGptUrl,
  isExpectedConversationPage,
  navigateAndCaptureConversationPayload,
  submitComposer,
  throwIfAborted,
  waitForPromise,
} from "./chatgpt-subagent-browser.js"
import { observeAssistantResponse, type AssistantResponseObservation } from "./chatgpt-subagent-observer.js"
import { extractConversationMessages, findLatestAssistantAfterPrompt } from "./chatgpt-subagent-protocol.js"
import { createSubagentStore, type SubagentStore } from "./subagent-store.js"
import {
  ChatGptSubagentError,
  type ChatGptSubagentActivity,
  type ChatGptSubagentOptions,
  type ChatGptSubagentPollResult,
  type ChatGptSubagentRequest,
  type ChatGptSubagentService,
  type ChatGptSubagentStartResult,
} from "./chatgpt-subagent-contracts.js"

const AGENT_IDLE_TTL_MS = 30 * 60_000
const CLEANUP_INTERVAL_MS = 60_000
const MAX_CONCURRENT_AGENTS = 3
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000
const RATE_LIMIT_SELECTOR = '[data-testid="modal-conversation-history-rate-limit"]'
const RATE_LIMIT_DISMISS_SETTLE_MS = 250
const RATE_LIMIT_ERROR_MESSAGE =
  "ChatGPT temporarily rate limited conversation access. New subagent turns are blocked during a 15-minute cooldown. Existing turns remain available through subagent_result. Do not retry automatically."
const SUBMISSION_GRACE_MS = 500
const SESSION_CORRELATION_TTL_MS = 30_000
const MANAGED_VIEWPORT = { width: 412, height: 915 } as const

const INJECTED_PROMPT =
  "Respond terse like smart caveman — drop articles, filler, pleasantries. Fragments OK. Technical terms exact. Code unchanged. Pattern: [thing] [action] [reason]. [next step].\n\nNot use `subagent` or `computer_*` tools."

export type BrowserAgentStatus = "idle" | "uncertain" | ChatGptSubagentActivity

export interface BrowserAgentState {
  agentId: string
  status: BrowserAgentStatus
  page?: Page
  conversationUrl?: string
  lastCompletedAt?: number
  lastUsedAt: number
  turnCount: number
}

export interface BrowserTurnState {
  turnId: string
  agentId: string
  parentSessionId?: string
  status: "running" | "completed" | "failed"
  recoveryAttempted: boolean
  lastActivityAt: number
  response?: string
  errorCode?: string
  errorMessage?: string
  prompt: string
  observation?: AssistantResponseObservation
  settled: Promise<void>
  settle: () => void
}

export interface ChatGptSubagentRuntimeState {
  cdpEndpoint: string
  connectTimeoutMs: number
  chatGptUrl: string
  maxConcurrentAgents: number
  minInterTurnDelayMs: number
  interactionDelayMs: number
  timeoutMs: number
  agents: Map<string, BrowserAgentState>
  turns: Map<string, BrowserTurnState>
  activeOperations: Map<string, string | null>
  pendingEvents: Map<string, string[]>
  subagentSessions: Map<string, string>
  pendingToolCalls: Array<{ agentId: string; toolName: string; createdAt: number }>
  recentSessionToolCalls: Array<{ sessionId: string; toolName: string; createdAt: number }>
  rateLimitedUntil: number
  browser?: Browser
  context?: BrowserContext
  connectPromise?: Promise<void>
  cleanupTimer?: NodeJS.Timeout
  store?: SubagentStore
  disposed: boolean
}

export interface ChatGptSubagentRuntimeService extends ChatGptSubagentService {
  connect(signal?: AbortSignal): Promise<void>
  drainEvents(sessionId?: string): string[]
}

export function createChatGptSubagentRuntimeState(options: ChatGptSubagentOptions = {}): ChatGptSubagentRuntimeState {
  return {
    cdpEndpoint: options.cdpEndpoint ?? MCP_CONFIG.chatGpt.cdpEndpoint,
    connectTimeoutMs: options.connectTimeoutMs ?? 3_000,
    chatGptUrl: options.chatGptUrl ?? MCP_CONFIG.chatGpt.projectUrl ?? "https://chatgpt.com/",
    maxConcurrentAgents: Math.min(positiveInteger(options.maxConcurrentAgents, MAX_CONCURRENT_AGENTS), MAX_CONCURRENT_AGENTS),
    minInterTurnDelayMs: nonNegativeInteger(options.minInterTurnDelayMs, 1_500),
    interactionDelayMs: nonNegativeInteger(options.interactionDelayMs, 300),
    timeoutMs: options.timeoutMs ?? 120_000,
    agents: new Map(),
    turns: new Map(),
    activeOperations: new Map(),
    pendingEvents: new Map(),
    subagentSessions: new Map(),
    pendingToolCalls: [],
    recentSessionToolCalls: [],
    rateLimitedUntil: 0,
    store: options.persistAgents === false ? undefined : createSubagentStore(),
    disposed: false,
  }
}

export function createChatGptSubagentService(options: ChatGptSubagentOptions = {}): ChatGptSubagentRuntimeService {
  const state = createChatGptSubagentRuntimeState(options)
  state.cleanupTimer = setInterval(() => void cleanupIdleAgents(state), CLEANUP_INTERVAL_MS)
  state.cleanupTimer.unref()
  return {
    connect: (signal) => connectSubagents(state, signal),
    ask: (request, signal) => askSubagent(state, request, signal),
    poll: (turnId, waitMs, signal) => pollSubagent(state, turnId, waitMs, signal),
    drainEvents: (sessionId) => drainPendingEvents(state, sessionId),
    agentIdForSession: (sessionId) => state.subagentSessions.get(sessionId),
    observeSessionToolCall: (sessionId, toolName) => observeSessionToolCall(state, sessionId, toolName),
    dispose: () => disposeSubagents(state),
  }
}

async function connectSubagents(state: ChatGptSubagentRuntimeState, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  if (state.browser?.isConnected() && state.context) return
  state.connectPromise ??= connectOnce(state).finally(() => {
    state.connectPromise = undefined
  })
  await waitForPromise(state.connectPromise, signal)
}

export async function askSubagent(
  state: ChatGptSubagentRuntimeState,
  request: ChatGptSubagentRequest,
  signal?: AbortSignal
): Promise<ChatGptSubagentStartResult> {
  assertNotRateLimited(state)
  beginAgentOperation(state, request.agentId)
  let agent: BrowserAgentState | undefined
  let observation: AssistantResponseObservation | undefined
  let operationTransferred = false

  try {
    await connectSubagents(state, signal)
    if (state.rateLimitedUntil > 0) await clearExpiredRateLimit(state, signal)
    else await detectRateLimit(state)

    agent = state.agents.get(request.agentId) ?? (await createAgent(state, request.agentId, signal))
    const activeAgent = agent
    await waitForInterTurn(state, agent, signal)
    const page = await ensureAgentPage(state, agent, signal)

    const submittedPrompt = agent.turnCount > 0 ? request.prompt : appendFirstTurnMode(request.prompt, request.oververbosity)
    const turnId = `${agent.agentId}_turn_${agent.turnCount + 1}`
    const settlement = createTurnSettlement()
    const turn: BrowserTurnState = {
      turnId,
      agentId: agent.agentId,
      parentSessionId: request.parentSessionId,
      status: "running",
      recoveryAttempted: false,
      lastActivityAt: Date.now(),
      prompt: submittedPrompt,
      settled: settlement.promise,
      settle: settlement.resolve,
    }

    observation = await observeAssistantResponse(page, {
      prompt: submittedPrompt,
      onConversationId: (conversationId) => bindConversation(state, activeAgent, conversationId, state.chatGptUrl),
      onToolCall: (recipient, text) => registerPendingToolCall(state, activeAgent.agentId, recipient, text),
      onActivity: (activity) => {
        activeAgent.status = activity
        turn.lastActivityAt = Date.now()
      },
    })

    await dismissBlockingChatGptOverlay(page, signal)
    const composer = await findComposer(page, state.timeoutMs, signal)
    await delay(state.interactionDelayMs, signal)
    assertManagedChatGptPage(page, agent.agentId, agent.conversationUrl)
    await enterPrompt(page, composer, submittedPrompt, signal)
    await delay(state.interactionDelayMs, signal)
    assertManagedChatGptPage(page, agent.agentId, agent.conversationUrl)
    await delay(SUBMISSION_GRACE_MS, signal)
    await detectRateLimit(state)
    await submitComposer(page, composer, signal)

    if (agent.status === "idle") agent.status = "Generating response"
    agent.lastUsedAt = Date.now()
    agent.turnCount += 1
    persistAgent(state, agent)
    turn.observation = observation
    state.turns.set(turnId, turn)
    state.activeOperations.set(agent.agentId, turnId)
    observation = undefined
    operationTransferred = true

    void waitForTurnResponse(state, turn, agent)
    return { agentId: agent.agentId, turnId, status: "running" }
  } catch (error) {
    await observation?.dispose().catch(() => undefined)
    if (!operationTransferred && agent) agent.status = "idle"
    throw error
  } finally {
    if (!operationTransferred) endAgentOperation(state, request.agentId)
  }
}

export async function pollSubagent(
  state: ChatGptSubagentRuntimeState,
  turnId: string,
  waitMs: number,
  signal?: AbortSignal
): Promise<ChatGptSubagentPollResult> {
  const turn = state.turns.get(turnId)
  if (!turn) throw new ChatGptSubagentError("UNKNOWN_TURN", `Unknown ChatGPT subagent turn: ${turnId}`)
  if (turn.status === "running" && waitMs > 0) await waitForTurnSettlement(turn.settled, waitMs, signal)
  throwIfAborted(signal)
  return turnResult(state, turn)
}

export async function createAgent(state: ChatGptSubagentRuntimeState, agentId: string, signal?: AbortSignal): Promise<BrowserAgentState> {
  const persisted = state.store?.get(agentId)
  const agent: BrowserAgentState = {
    agentId,
    status: "idle",
    lastUsedAt: Date.now(),
    turnCount: persisted?.turnCount ?? 0,
    conversationUrl: persisted?.conversationUrl,
  }
  await ensureAgentPage(state, agent, signal)
  state.agents.set(agentId, agent)
  return agent
}

export async function ensureAgentPage(state: ChatGptSubagentRuntimeState, agent: BrowserAgentState, signal?: AbortSignal): Promise<Page> {
  throwIfAborted(signal)
  const page = agent.page && !agent.page.isClosed() ? agent.page : undefined
  if (agent.turnCount > 0) captureConversationUrlFromPage(agent)
  if (page && isExpectedConversationPage(page, agent.conversationUrl)) return page
  const targetUrl = agent.conversationUrl ?? (agent.turnCount === 0 ? state.chatGptUrl : undefined)
  if (!targetUrl) {
    throw new ChatGptSubagentError("AGENT_TARGET_LOST", `ChatGPT subagent ${agent.agentId} lost its page before its conversation URL was saved.`)
  }

  const created = !page
  const restoredPage = page ?? (await createManagedPage(state))
  try {
    await waitForPromise(restoredPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: state.timeoutMs }), signal)
    await assertAuthenticated(restoredPage)
    assertManagedChatGptPage(restoredPage, agent.agentId, agent.conversationUrl)
    await findComposer(restoredPage, state.timeoutMs, signal)
    agent.page = restoredPage
    agent.lastUsedAt = Date.now()
    return restoredPage
  } catch (error) {
    if (created && !restoredPage.isClosed()) await restoredPage.close().catch(() => undefined)
    throw error
  }
}

export async function waitForTurnResponse(state: ChatGptSubagentRuntimeState, turn: BrowserTurnState, agent: BrowserAgentState): Promise<void> {
  const observation = turn.observation
  if (!observation) return
  try {
    const result = await observation.response
    if (state.disposed || turn.status !== "running" || turn.observation !== observation) return
    if (result.conversationId) bindConversation(state, agent, result.conversationId, state.chatGptUrl)
    completeTurn(state, turn, agent, result.text)
  } catch (error) {
    if (state.disposed || turn.status !== "running" || turn.observation !== observation) return
    await failOrRecoverSubmittedTurn(state, turn, agent, error)
  }
}

export async function failOrRecoverSubmittedTurn(
  state: ChatGptSubagentRuntimeState,
  turn: BrowserTurnState,
  agent: BrowserAgentState,
  originalError: unknown,
  signal?: AbortSignal
): Promise<void> {
  if (turn.status !== "running") return

  const oldObservation = turn.observation
  turn.observation = undefined
  await oldObservation?.dispose().catch(() => undefined)

  captureConversationUrlFromPage(agent)

  if (!turn.recoveryAttempted && agent.conversationUrl) {
    turn.recoveryAttempted = true
    turn.lastActivityAt = Date.now()
    agent.status = "Working"
    try {
      if (await recoverSubmittedTurn(state, turn, agent, signal)) return
    } catch (recoveryError) {
      originalError = recoveryError
    }
  }

  agent.status = "uncertain"
  failTurn(state, turn, agent, originalError)
}

export async function recoverSubmittedTurn(
  state: ChatGptSubagentRuntimeState,
  turn: BrowserTurnState,
  agent: BrowserAgentState,
  signal?: AbortSignal
): Promise<boolean> {
  const conversationUrl = agent.conversationUrl
  const conversationId = conversationUrl ? extractConversationId(conversationUrl) : undefined
  if (!conversationUrl || !conversationId) {
    throw new ChatGptSubagentError("AGENT_TARGET_LOST", `ChatGPT subagent ${agent.agentId} has no saved conversation to recover.`)
  }

  const oldPage = agent.page
  const page = await createManagedPage(state)
  try {
    const payload = await navigateAndCaptureConversationPayload(page, conversationUrl, conversationId, state.timeoutMs, signal)
    await assertAuthenticated(page)
    assertManagedChatGptPage(page, agent.agentId, conversationUrl)
    await findComposer(page, state.timeoutMs, signal)

    agent.page = page
    agent.lastUsedAt = Date.now()
    if (oldPage && !oldPage.isClosed()) await oldPage.close().catch(() => undefined)

    const answer = findLatestAssistantAfterPrompt(extractConversationMessages(payload), turn.prompt, agent.turnCount)
    if (!answer) return false
    completeTurn(state, turn, agent, answer.text)
    return true
  } catch (error) {
    if (agent.page !== page && !page.isClosed()) await page.close().catch(() => undefined)
    throw error
  }
}
export async function disposeSubagents(state: ChatGptSubagentRuntimeState): Promise<void> {
  state.disposed = true
  if (state.cleanupTimer) clearInterval(state.cleanupTimer)
  const browser = state.browser
  const observations = [...state.turns.values()].map((turn) => turn.observation).filter((value): value is AssistantResponseObservation => value !== undefined)
  const pages = [...state.agents.values()].map((agent) => agent.page).filter((page): page is Page => page !== undefined && !page.isClosed())
  for (const turn of state.turns.values()) turn.settle()
  state.agents.clear()
  state.turns.clear()
  state.activeOperations.clear()
  state.pendingEvents.clear()
  state.subagentSessions.clear()
  state.pendingToolCalls.length = 0
  state.recentSessionToolCalls.length = 0
  state.context = undefined
  state.browser = undefined
  state.connectPromise = undefined
  state.cleanupTimer = undefined
  state.store?.close()
  state.store = undefined
  await Promise.allSettled([...observations.map((observation) => observation.dispose()), ...pages.map((page) => page.close())])
  await browser?.close().catch(() => undefined)
}

export function beginAgentOperation(state: ChatGptSubagentRuntimeState, agentId: string): void {
  if (state.activeOperations.has(agentId)) throw new ChatGptSubagentError("AGENT_BUSY", `ChatGPT subagent ${agentId} already has an active turn.`)
  const agent = state.agents.get(agentId)
  if (agent?.status === "uncertain") {
    throw new ChatGptSubagentError(
      "AGENT_BUSY",
      `ChatGPT subagent ${agentId} has uncertain upstream state after recovery could not confirm completion. Use a new agent_id.`
    )
  }
  if (agent && agent.status !== "idle") {
    throw new ChatGptSubagentError("AGENT_BUSY", `ChatGPT subagent ${agentId} is still ${agent.status}.`)
  }
  if (state.activeOperations.size >= state.maxConcurrentAgents) {
    throw new ChatGptSubagentError("SUBAGENT_CAPACITY_REACHED", `ChatGPT subagent generation capacity is ${state.maxConcurrentAgents}.`)
  }
  state.activeOperations.set(agentId, null)
}

export function endAgentOperation(state: ChatGptSubagentRuntimeState, agentId: string): void {
  state.activeOperations.delete(agentId)
}

export async function clearExpiredRateLimit(state: ChatGptSubagentRuntimeState, signal?: AbortSignal): Promise<void> {
  if (state.rateLimitedUntil === 0 || Date.now() < state.rateLimitedUntil) return
  for (const page of state.context?.pages() ?? []) {
    if (!isChatGptUrl(page.url())) continue
    const modal = page.locator(RATE_LIMIT_SELECTOR).first()
    if (!(await modal.isVisible().catch(() => false))) continue
    const button = modal.getByRole("button", { name: /got it|okay|ok|close/i }).first()
    await button.click().catch(() => page.keyboard.press("Escape"))
    await delay(RATE_LIMIT_DISMISS_SETTLE_MS, signal)
  }
  state.rateLimitedUntil = 0
}

function completeTurn(state: ChatGptSubagentRuntimeState, turn: BrowserTurnState, agent: BrowserAgentState, response: string): void {
  if (turn.status !== "running") return
  const now = Date.now()
  captureConversationUrlFromPage(agent)
  persistAgent(state, agent)
  agent.lastCompletedAt = now
  agent.lastUsedAt = now
  agent.status = "idle"
  turn.status = "completed"
  turn.response = response
  settleTurn(state, turn, agent)
  const sessionKey = turn.parentSessionId ?? ""
  const events = state.pendingEvents.get(sessionKey) ?? []
  events.push(`agent_finished:${turn.agentId}:${turn.turnId}`)
  state.pendingEvents.set(sessionKey, events)
}

function drainPendingEvents(state: ChatGptSubagentRuntimeState, sessionId?: string): string[] {
  const key = sessionId ?? ""
  const events = state.pendingEvents.get(key) ?? []
  state.pendingEvents.delete(key)
  return events
}

function registerPendingToolCall(state: ChatGptSubagentRuntimeState, agentId: string, recipient: string, text: string): void {
  const toolName = toolNameFromCall(recipient, text)
  if (!toolName) return
  const cutoff = Date.now() - SESSION_CORRELATION_TTL_MS
  state.recentSessionToolCalls = state.recentSessionToolCalls.filter((call) => call.createdAt >= cutoff)
  const recentIndex = state.recentSessionToolCalls.findIndex((call) => call.toolName === toolName)
  if (recentIndex >= 0) {
    const [recent] = state.recentSessionToolCalls.splice(recentIndex, 1)
    if (recent) bindSubagentSession(state, recent.sessionId, agentId)
    return
  }
  state.pendingToolCalls = state.pendingToolCalls.filter((call) => call.createdAt >= cutoff).slice(-31)
  state.pendingToolCalls.push({ agentId, toolName, createdAt: Date.now() })
}

export function observeSessionToolCall(state: ChatGptSubagentRuntimeState, sessionId: string, toolName: string): string | undefined {
  const known = state.subagentSessions.get(sessionId)
  if (known) return known
  const cutoff = Date.now() - SESSION_CORRELATION_TTL_MS
  state.pendingToolCalls = state.pendingToolCalls.filter((call) => call.createdAt >= cutoff)
  const index = state.pendingToolCalls.findIndex((call) => call.toolName === toolName)
  if (index >= 0) {
    const [call] = state.pendingToolCalls.splice(index, 1)
    if (call) {
      bindSubagentSession(state, sessionId, call.agentId)
      return call.agentId
    }
  }
  state.recentSessionToolCalls = state.recentSessionToolCalls.filter((call) => call.createdAt >= cutoff).slice(-31)
  state.recentSessionToolCalls.push({ sessionId, toolName, createdAt: Date.now() })
  return undefined
}

function bindSubagentSession(state: ChatGptSubagentRuntimeState, sessionId: string, agentId: string): void {
  if (state.subagentSessions.get(sessionId) === agentId) return
  state.subagentSessions.set(sessionId, agentId)
}

function toolNameFromCall(recipient: string, text: string): string | undefined {
  const recipientName = recipient.split(".").at(-1)?.trim()
  if (!recipientName) return undefined
  if (recipientName !== "call_tool") return recipientName
  try {
    const payload = asRecord(JSON.parse(text))
    if (typeof payload?.path === "string") return payload.path.split("/").filter(Boolean).at(-1)?.trim()
  } catch {
    return undefined
  }
  return undefined
}

function failTurn(state: ChatGptSubagentRuntimeState, turn: BrowserTurnState, agent: BrowserAgentState, error: unknown): void {
  if (turn.status !== "running") return
  turn.status = "failed"
  turn.errorCode = error instanceof ChatGptSubagentError ? error.code : "subagent_failed"
  turn.errorMessage = error instanceof Error ? error.message : String(error)
  settleTurn(state, turn, agent)
}

function settleTurn(state: ChatGptSubagentRuntimeState, turn: BrowserTurnState, agent: BrowserAgentState): void {
  void turn.observation?.dispose().catch(() => undefined)
  turn.observation = undefined
  if (state.activeOperations.get(agent.agentId) === turn.turnId) state.activeOperations.delete(agent.agentId)
  turn.settle()
}

async function connectOnce(state: ChatGptSubagentRuntimeState): Promise<void> {
  try {
    const { chromium } = await import("playwright-core")
    state.browser = await chromium.connectOverCDP(state.cdpEndpoint, { timeout: state.connectTimeoutMs })
  } catch (error) {
    throw new ChatGptSubagentError(
      "BROWSER_UNAVAILABLE",
      [
        "ChatGPT agent browser is unavailable.",
        `Expected an already-running debuggable Chrome instance at ${state.cdpEndpoint}.`,
        "This module is attach-only and will not launch Chrome or choose a Chrome profile.",
      ].join(" "),
      { cause: error }
    )
  }
  const [context] = state.browser.contexts()
  if (!context) throw new ChatGptSubagentError("BROWSER_UNAVAILABLE", "Connected Chrome instance did not expose a browser context.")
  state.context = context
}

async function createManagedPage(state: ChatGptSubagentRuntimeState): Promise<Page> {
  if (!state.browser || !state.context) throw new ChatGptSubagentError("BROWSER_UNAVAILABLE", "ChatGPT browser is not connected.")
  const page = await createBackgroundPage(state.browser, state.context)
  try {
    await page.setViewportSize(MANAGED_VIEWPORT)
    return page
  } catch (error) {
    if (!page.isClosed()) await page.close().catch(() => undefined)
    throw error
  }
}

function bindConversation(state: ChatGptSubagentRuntimeState, agent: BrowserAgentState, conversationId: string, startUrl: string): void {
  const pageUrl = agent.page && !agent.page.isClosed() ? agent.page.url() : undefined
  if (pageUrl && extractConversationId(pageUrl) === conversationId) agent.conversationUrl = pageUrl
  else if (extractConversationId(agent.conversationUrl ?? "") !== conversationId) {
    agent.conversationUrl = conversationUrlForStart(startUrl, conversationId)
  }
  persistAgent(state, agent)
}

function captureConversationUrlFromPage(agent: BrowserAgentState): void {
  if (agent.conversationUrl || !agent.page || agent.page.isClosed()) return
  const pageUrl = agent.page.url()
  if (extractConversationId(pageUrl)) agent.conversationUrl = pageUrl
}

function persistAgent(state: ChatGptSubagentRuntimeState, agent: BrowserAgentState): void {
  if (!agent.conversationUrl) return
  state.store?.set(agent.agentId, { conversationUrl: agent.conversationUrl, turnCount: agent.turnCount })
}

export function conversationUrlForStart(startUrl: string, conversationId: string): string {
  const url = new URL(startUrl)
  const encodedId = encodeURIComponent(conversationId)
  if (/\/g\/g-p-[^/]+\/project\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/project\/?$/, "")}/c/${encodedId}`
    url.search = ""
    url.hash = ""
    return url.toString()
  }
  return `https://chatgpt.com/c/${encodedId}`
}
async function waitForInterTurn(state: ChatGptSubagentRuntimeState, agent: BrowserAgentState, signal?: AbortSignal): Promise<void> {
  if (agent.lastCompletedAt === undefined) return
  const remaining = agent.lastCompletedAt + state.minInterTurnDelayMs - Date.now()
  if (remaining > 0) await delay(remaining, signal)
}

function assertNotRateLimited(state: ChatGptSubagentRuntimeState): void {
  if (Date.now() >= state.rateLimitedUntil) return
  throw new ChatGptSubagentError("SUBAGENT_RATE_LIMITED", RATE_LIMIT_ERROR_MESSAGE)
}

async function detectRateLimit(state: ChatGptSubagentRuntimeState): Promise<void> {
  assertNotRateLimited(state)
  for (const page of state.context?.pages() ?? []) {
    if (!isChatGptUrl(page.url())) continue
    const visible = await page
      .locator(RATE_LIMIT_SELECTOR)
      .first()
      .isVisible()
      .catch(() => false)
    if (!visible) continue
    state.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
    throw new ChatGptSubagentError("SUBAGENT_RATE_LIMITED", RATE_LIMIT_ERROR_MESSAGE)
  }
}

export async function cleanupIdleAgents(state: ChatGptSubagentRuntimeState, now = Date.now()): Promise<void> {
  if (state.disposed) return
  for (const agent of state.agents.values()) {
    const activeOperation = state.activeOperations.get(agent.agentId)
    const activeTurn = typeof activeOperation === "string" ? state.turns.get(activeOperation) : undefined

    if (activeTurn?.status === "running") {
      if (now - activeTurn.lastActivityAt >= AGENT_IDLE_TTL_MS) {
        await failOrRecoverSubmittedTurn(
          state,
          activeTurn,
          agent,
          new ChatGptSubagentError("AGENT_IDLE_EXPIRED", "ChatGPT subagent turn expired after 30 minutes without observable progress.")
        )
      }
      continue
    }

    if (activeOperation === null || now - agent.lastUsedAt < AGENT_IDLE_TTL_MS) continue
    const page = agent.page
    if (page && !page.isClosed()) await page.close().catch(() => undefined)
    if (agent.page === page) agent.page = undefined
  }
}

function createTurnSettlement(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitForTurnSettlement(settled: Promise<void>, waitMs: number, signal?: AbortSignal): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await waitForPromise(Promise.race([settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]), signal).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function turnResult(state: ChatGptSubagentRuntimeState, turn: BrowserTurnState): ChatGptSubagentPollResult {
  const agentStatus = state.agents.get(turn.agentId)?.status
  const activity = agentStatus === "idle" || agentStatus === "uncertain" ? undefined : agentStatus
  return {
    turnId: turn.turnId,
    status: turn.status,
    activity: turn.status === "running" ? activity : undefined,
    activityAgeMs: turn.status === "running" ? Math.max(0, Date.now() - turn.lastActivityAt) : undefined,
    response: turn.response,
    errorCode: turn.errorCode,
    errorMessage: turn.errorMessage,
  }
}

export function appendFirstTurnMode(prompt: string, oververbosity: number): string {
  if (oververbosity === 5) return prompt
  const level = oververbosity === 1 ? "ultra" : oververbosity === 2 ? "full" : "lite"
  const qualifier = oververbosity === 4 ? " Favor completeness over terseness when useful." : ""
  return `${prompt}\n\n---\n\nSwitch to caveman ${level} mode. ${INJECTED_PROMPT}${qualifier}`
}
