import type { Browser, BrowserContext, Page } from "playwright-core"

import { MCP_CONFIG } from "../../config.js"
import {
  assertAuthenticated,
  assertManagedChatGptPage,
  createBackgroundPage,
  delay,
  dismissBlockingChatGptOverlay,
  enterPrompt,
  extractConversationId,
  findComposer,
  forkLatestConversationTurn,
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
  type ChatGptCloneRunRequest,
  type ChatGptCloneSelfRequest,
  type ChatGptSubagentActivity,
  type ChatGptSubagentPollResult,
  type ChatGptSubagentRequest,
  type ChatGptSubagentService,
  type ChatGptSubagentStartResult,
} from "./chatgpt-subagent-contracts.js"

const AGENT_IDLE_TTL_MS = 30 * 60_000
const CLEANUP_INTERVAL_MS = 60_000
const MAX_CONCURRENT_AGENTS = 3
const CONNECT_TIMEOUT_MS = 3_000
const MIN_INTER_TURN_DELAY_MS = 1_500
const INTERACTION_DELAY_MS = 300
const TURN_TIMEOUT_MS = 120_000
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000
const RATE_LIMIT_SELECTOR = '[data-testid="modal-conversation-history-rate-limit"]'
const RATE_LIMIT_DISMISS_SETTLE_MS = 250
const CLONE_INITIAL_SETTLE_MS = 5_000
const RATE_LIMIT_ERROR_MESSAGE =
  "ChatGPT temporarily rate limited conversation access. New subagent turns are blocked during a 15-minute cooldown. Existing turns remain available through subagent_result. Do not retry automatically."
const SUBMISSION_GRACE_MS = 500
const MANAGED_VIEWPORT = { width: 412, height: 915 } as const
const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true"
const CHATGPT_START_URL = MCP_CONFIG.chatGpt.projectUrl ?? "https://chatgpt.com/"

const INJECTED_PROMPT =
  "Respond terse like smart caveman — drop articles, filler, pleasantries. Fragments OK. Technical terms exact. Code unchanged. Pattern: [thing] [action] [reason]. [next step].\n\nNot use `subagent` or `computer_*` tools."

type BrowserAgentStatus = "idle" | "uncertain" | ChatGptSubagentActivity

interface BrowserAgentState {
  agentId: string
  kind?: "subagent" | "clone"
  memory: boolean
  status: BrowserAgentStatus
  page?: Page
  conversationUrl?: string
  lastCompletedAt?: number
  lastUsedAt: number
  turnCount: number
}

interface BrowserTurnState {
  turnId: string
  agentId: string
  notificationSessionId?: string
  status: "running" | "completed" | "failed"
  recoveryAttempted: boolean
  lastActivityAt: number
  response?: string
  errorCode?: string
  errorMessage?: string
  prompt: string
  bindConversationFromObserver?: boolean
  observation?: AssistantResponseObservation
  settled: Promise<void>
  settle: () => void
}

interface ChatGptSubagentRuntimeState {
  agents: Map<string, BrowserAgentState>
  turns: Map<string, BrowserTurnState>
  activeOperations: Map<string, string | null>
  pendingEvents: Map<string, string[]>
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
  cloneSelf(request: ChatGptCloneSelfRequest, signal?: AbortSignal): Promise<ChatGptSubagentStartResult>
  drainEvents(sessionId?: string): string[]
}

export function createChatGptSubagentService(): ChatGptSubagentRuntimeService {
  const state: ChatGptSubagentRuntimeState = {
    agents: new Map(),
    turns: new Map(),
    activeOperations: new Map(),
    pendingEvents: new Map(),
    rateLimitedUntil: 0,
    store: createSubagentStore(),
    disposed: false,
  }

  state.cleanupTimer = setInterval(() => void cleanupIdleAgents(), CLEANUP_INTERVAL_MS)
  state.cleanupTimer.unref()

  async function connectSubagents(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    if (state.browser?.isConnected() && state.context) return
    state.connectPromise ??= connectOnce().finally(() => {
      state.connectPromise = undefined
    })
    await waitForPromise(state.connectPromise, signal)
  }

  async function askSubagent(request: ChatGptSubagentRequest, signal?: AbortSignal): Promise<ChatGptSubagentStartResult> {
    assertNotRateLimited()
    beginAgentOperation(request.agentId)
    let agent: BrowserAgentState | undefined
    let operationTransferred = false

    try {
      await connectSubagents(signal)
      if (state.rateLimitedUntil > 0) await clearExpiredRateLimit(signal)
      else await detectRateLimit()

      agent = state.agents.get(request.agentId) ?? (await createAgent(request.agentId, signal, request.memory ?? true))
      const submittedPrompt = agent.turnCount > 0 ? request.prompt : appendFirstTurnMode(request.prompt, request.oververbosity)
      const result = await submitAgentTurn(agent, submittedPrompt, request.notificationSessionId, true, signal)
      operationTransferred = true
      return result
    } catch (error) {
      if (!operationTransferred && agent) agent.status = "idle"
      throw error
    } finally {
      if (!operationTransferred) endAgentOperation(request.agentId)
    }
  }

  async function cloneSelf(request: ChatGptCloneSelfRequest, signal?: AbortSignal): Promise<ChatGptSubagentStartResult> {
    assertNotRateLimited()
    beginAgentOperation(request.cloneId)
    let sourcePage: Page | undefined
    let branchPage: Page | undefined
    let agent: BrowserAgentState | undefined
    let operationTransferred = false

    try {
      await connectSubagents(signal)
      if (state.rateLimitedUntil > 0) await clearExpiredRateLimit(signal)
      else await detectRateLimit()

      if (!isChatGptUrl(request.sourceConversationUrl)) {
        throw new ChatGptSubagentError("AGENT_TARGET_LOST", "clone_self requires a chatgpt.com conversation URL.")
      }
      if (state.agents.has(request.cloneId) || state.store?.get(request.cloneId)) {
        throw new ChatGptSubagentError("AGENT_BUSY", `Clone ${request.cloneId} already exists.`)
      }

      sourcePage = await createManagedPage()
      await waitForPromise(sourcePage.goto(request.sourceConversationUrl, { waitUntil: "domcontentloaded", timeout: TURN_TIMEOUT_MS }), signal)
      await assertAuthenticated(sourcePage)
      branchPage = await forkLatestConversationTurn(sourcePage, TURN_TIMEOUT_MS, signal)
      if (branchPage !== sourcePage && !sourcePage.isClosed()) await sourcePage.close().catch(() => undefined)
      sourcePage = undefined
      await branchPage.setViewportSize(MANAGED_VIEWPORT)

      agent = {
        agentId: request.cloneId,
        kind: "clone",
        memory: true,
        status: "idle",
        page: branchPage,
        lastUsedAt: Date.now(),
        turnCount: 0,
      }
      state.agents.set(agent.agentId, agent)

      await delay(CLONE_INITIAL_SETTLE_MS, signal)
      const result = await submitAgentTurn(agent, request.prompt, request.notificationSessionId, false, signal)
      operationTransferred = true
      return result
    } catch (error) {
      if (agent) state.agents.delete(agent.agentId)
      if (branchPage && !branchPage.isClosed()) await branchPage.close().catch(() => undefined)
      if (sourcePage && !sourcePage.isClosed()) await sourcePage.close().catch(() => undefined)
      throw error
    } finally {
      if (!operationTransferred) endAgentOperation(request.cloneId)
    }
  }

  async function cloneRun(request: ChatGptCloneRunRequest, signal?: AbortSignal): Promise<ChatGptSubagentStartResult> {
    assertNotRateLimited()
    beginAgentOperation(request.cloneId)
    let agent: BrowserAgentState | undefined
    let operationTransferred = false

    try {
      await connectSubagents(signal)
      if (state.rateLimitedUntil > 0) await clearExpiredRateLimit(signal)
      else await detectRateLimit()

      agent = state.agents.get(request.cloneId)
      if (!agent) {
        const persisted = state.store?.get(request.cloneId)
        if (!persisted || persisted.kind !== "clone") {
          throw new ChatGptSubagentError("AGENT_TARGET_LOST", `Unknown clone: ${request.cloneId}`)
        }
        agent = {
          agentId: request.cloneId,
          kind: "clone",
          memory: true,
          status: "idle",
          lastUsedAt: Date.now(),
          turnCount: persisted.turnCount,
          conversationUrl: persisted.conversationUrl,
        }
        await ensureAgentPage(agent, signal)
        state.agents.set(agent.agentId, agent)
      } else if (agent.kind !== "clone") {
        throw new ChatGptSubagentError("AGENT_TARGET_LOST", `${request.cloneId} is not a clone.`)
      }

      const result = await submitAgentTurn(agent, request.prompt, request.notificationSessionId, false, signal)
      operationTransferred = true
      return result
    } catch (error) {
      if (!operationTransferred && agent) agent.status = "idle"
      throw error
    } finally {
      if (!operationTransferred) endAgentOperation(request.cloneId)
    }
  }

  async function submitAgentTurn(
    agent: BrowserAgentState,
    submittedPrompt: string,
    notificationSessionId: string | undefined,
    bindConversationFromObserver: boolean,
    signal?: AbortSignal
  ): Promise<ChatGptSubagentStartResult> {
    let observation: AssistantResponseObservation | undefined
    try {
      await waitForInterTurn(agent, signal)
      const page = await ensureAgentPage(agent, signal)
      const turnId = `${agent.agentId}_turn_${agent.turnCount + 1}`
      const settlement = createTurnSettlement()
      const turn: BrowserTurnState = {
        turnId,
        agentId: agent.agentId,
        notificationSessionId,
        status: "running",
        recoveryAttempted: false,
        lastActivityAt: Date.now(),
        prompt: submittedPrompt,
        bindConversationFromObserver,
        settled: settlement.promise,
        settle: settlement.resolve,
      }

      observation = await observeAssistantResponse(page, {
        prompt: submittedPrompt,
        onConversationId: bindConversationFromObserver ? (conversationId) => bindConversation(agent, conversationId) : undefined,
        onActivity: (activity) => {
          agent.status = activity
          turn.lastActivityAt = Date.now()
        },
      })

      await dismissBlockingChatGptOverlay(page, signal)
      const composer = await findComposer(page, TURN_TIMEOUT_MS, signal)
      await delay(INTERACTION_DELAY_MS, signal)
      assertManagedChatGptPage(page, agent.agentId, agent.conversationUrl)
      await enterPrompt(page, composer, submittedPrompt, signal)
      await delay(INTERACTION_DELAY_MS, signal)
      assertManagedChatGptPage(page, agent.agentId, agent.conversationUrl)
      await delay(SUBMISSION_GRACE_MS, signal)
      await detectRateLimit()
      await submitComposer(page, composer, signal)

      if (agent.status === "idle") agent.status = "Working"
      agent.lastUsedAt = Date.now()
      agent.turnCount += 1
      persistAgent(agent)
      turn.observation = observation
      state.turns.set(turnId, turn)
      state.activeOperations.set(agent.agentId, turnId)
      observation = undefined

      void waitForTurnResponse(turn, agent)
      return { agentId: agent.agentId, turnId, status: "running" }
    } catch (error) {
      await observation?.dispose().catch(() => undefined)
      throw error
    }
  }

  async function pollSubagent(turnId: string, waitMs: number, signal?: AbortSignal): Promise<ChatGptSubagentPollResult> {
    const turn = state.turns.get(turnId)
    if (!turn) throw new ChatGptSubagentError("UNKNOWN_TURN", `Unknown ChatGPT subagent turn: ${turnId}`)
    if (turn.status === "running" && waitMs > 0) await waitForTurnSettlement(turn.settled, waitMs, signal)
    throwIfAborted(signal)
    return turnResult(turn)
  }

  async function createAgent(agentId: string, signal?: AbortSignal, memory = true): Promise<BrowserAgentState> {
    const persisted = memory ? state.store?.get(agentId) : undefined
    const agent: BrowserAgentState = {
      agentId,
      kind: persisted?.kind ?? "subagent",
      memory,
      status: "idle",
      lastUsedAt: Date.now(),
      turnCount: persisted?.turnCount ?? 0,
      conversationUrl: persisted?.conversationUrl,
    }
    await ensureAgentPage(agent, signal)
    state.agents.set(agentId, agent)
    return agent
  }

  async function ensureAgentPage(agent: BrowserAgentState, signal?: AbortSignal): Promise<Page> {
    throwIfAborted(signal)
    const page = agent.page && !agent.page.isClosed() ? agent.page : undefined
    if (agent.turnCount > 0) captureConversationUrlFromPage(agent)
    if (page && isExpectedConversationPage(page, agent.conversationUrl)) return page
    const targetUrl = agent.conversationUrl ?? (agent.turnCount === 0 ? (agent.memory ? CHATGPT_START_URL : TEMPORARY_CHAT_URL) : undefined)
    if (!targetUrl) {
      throw new ChatGptSubagentError("AGENT_TARGET_LOST", `ChatGPT subagent ${agent.agentId} lost its page before its conversation URL was saved.`)
    }

    const created = !page
    const restoredPage = page ?? (await createManagedPage())
    try {
      await waitForPromise(restoredPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: TURN_TIMEOUT_MS }), signal)
      await assertAuthenticated(restoredPage)
      assertManagedChatGptPage(restoredPage, agent.agentId, agent.conversationUrl)
      await findComposer(restoredPage, TURN_TIMEOUT_MS, signal)
      agent.page = restoredPage
      agent.lastUsedAt = Date.now()
      return restoredPage
    } catch (error) {
      if (created && !restoredPage.isClosed()) await restoredPage.close().catch(() => undefined)
      throw error
    }
  }

  async function waitForTurnResponse(turn: BrowserTurnState, agent: BrowserAgentState): Promise<void> {
    const observation = turn.observation
    if (!observation) return
    try {
      const result = await observation.response
      if (state.disposed || turn.status !== "running" || turn.observation !== observation) return
      if (turn.bindConversationFromObserver !== false && result.conversationId) bindConversation(agent, result.conversationId)
      completeTurn(turn, agent, result.text)
    } catch (error) {
      if (state.disposed || turn.status !== "running" || turn.observation !== observation) return
      await failOrRecoverSubmittedTurn(turn, agent, error)
    }
  }

  async function failOrRecoverSubmittedTurn(turn: BrowserTurnState, agent: BrowserAgentState, originalError: unknown, signal?: AbortSignal): Promise<void> {
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
        if (await recoverSubmittedTurn(turn, agent, signal)) return
      } catch (recoveryError) {
        originalError = recoveryError
      }
    }

    agent.status = "uncertain"
    failTurn(turn, agent, originalError)
  }

  async function recoverSubmittedTurn(turn: BrowserTurnState, agent: BrowserAgentState, signal?: AbortSignal): Promise<boolean> {
    const conversationUrl = agent.conversationUrl
    const conversationId = conversationUrl ? extractConversationId(conversationUrl) : undefined
    if (!conversationUrl || !conversationId) {
      throw new ChatGptSubagentError("AGENT_TARGET_LOST", `ChatGPT subagent ${agent.agentId} has no saved conversation to recover.`)
    }

    const oldPage = agent.page
    const page = await createManagedPage()
    try {
      const payload = await navigateAndCaptureConversationPayload(page, conversationUrl, conversationId, TURN_TIMEOUT_MS, signal)
      await assertAuthenticated(page)
      assertManagedChatGptPage(page, agent.agentId, conversationUrl)
      await findComposer(page, TURN_TIMEOUT_MS, signal)

      agent.page = page
      agent.lastUsedAt = Date.now()
      if (oldPage && !oldPage.isClosed()) await oldPage.close().catch(() => undefined)

      const answer = findLatestAssistantAfterPrompt(extractConversationMessages(payload), turn.prompt, agent.turnCount)
      if (!answer) return false
      completeTurn(turn, agent, answer.text)
      return true
    } catch (error) {
      if (agent.page !== page && !page.isClosed()) await page.close().catch(() => undefined)
      throw error
    }
  }

  async function disposeSubagents(): Promise<void> {
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
    state.context = undefined
    state.browser = undefined
    state.connectPromise = undefined
    state.cleanupTimer = undefined
    state.store?.close()
    state.store = undefined
    await Promise.allSettled([...observations.map((observation) => observation.dispose()), ...pages.map((page) => page.close())])
    await browser?.close().catch(() => undefined)
  }

  function beginAgentOperation(agentId: string): void {
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
    if (state.activeOperations.size >= MAX_CONCURRENT_AGENTS) {
      throw new ChatGptSubagentError("SUBAGENT_CAPACITY_REACHED", `ChatGPT subagent generation capacity is ${MAX_CONCURRENT_AGENTS}.`)
    }
    state.activeOperations.set(agentId, null)
  }

  function endAgentOperation(agentId: string): void {
    state.activeOperations.delete(agentId)
  }

  async function clearExpiredRateLimit(signal?: AbortSignal): Promise<void> {
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

  function completeTurn(turn: BrowserTurnState, agent: BrowserAgentState, response: string): void {
    if (turn.status !== "running") return
    const now = Date.now()
    captureConversationUrlFromPage(agent)
    persistAgent(agent)
    agent.lastCompletedAt = now
    agent.lastUsedAt = now
    agent.status = "idle"
    turn.status = "completed"
    turn.response = response
    settleTurn(turn, agent)
    const sessionKey = turn.notificationSessionId ?? ""
    const events = state.pendingEvents.get(sessionKey) ?? []
    events.push(`agent_finished agent_id=${turn.agentId} turn_id=${turn.turnId}`)
    state.pendingEvents.set(sessionKey, events)
  }

  function drainPendingEvents(sessionId?: string): string[] {
    const key = sessionId ?? ""
    const events = state.pendingEvents.get(key) ?? []
    state.pendingEvents.delete(key)
    return events
  }

  function failTurn(turn: BrowserTurnState, agent: BrowserAgentState, error: unknown): void {
    if (turn.status !== "running") return
    turn.status = "failed"
    turn.errorCode = error instanceof ChatGptSubagentError ? error.code : "subagent_failed"
    turn.errorMessage = error instanceof Error ? error.message : String(error)
    settleTurn(turn, agent)
  }

  function settleTurn(turn: BrowserTurnState, agent: BrowserAgentState): void {
    void turn.observation?.dispose().catch(() => undefined)
    turn.observation = undefined
    if (state.activeOperations.get(agent.agentId) === turn.turnId) state.activeOperations.delete(agent.agentId)
    turn.settle()
  }

  async function connectOnce(): Promise<void> {
    try {
      const { chromium } = await import("playwright-core")
      state.browser = await chromium.connectOverCDP(MCP_CONFIG.chatGpt.cdpEndpoint, { timeout: CONNECT_TIMEOUT_MS })
    } catch (error) {
      throw new ChatGptSubagentError(
        "BROWSER_UNAVAILABLE",
        [
          "ChatGPT agent browser is unavailable.",
          `Expected an already-running debuggable Chrome instance at ${MCP_CONFIG.chatGpt.cdpEndpoint}.`,
          "This module is attach-only and will not launch Chrome or choose a Chrome profile.",
        ].join(" "),
        { cause: error }
      )
    }
    const [context] = state.browser.contexts()
    if (!context) throw new ChatGptSubagentError("BROWSER_UNAVAILABLE", "Connected Chrome instance did not expose a browser context.")
    state.context = context
  }

  async function createManagedPage(): Promise<Page> {
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

  function bindConversation(agent: BrowserAgentState, conversationId: string): void {
    if (!agent.memory) return
    const pageUrl = agent.page && !agent.page.isClosed() ? agent.page.url() : undefined
    if (pageUrl && extractConversationId(pageUrl) === conversationId) agent.conversationUrl = pageUrl
    else if (extractConversationId(agent.conversationUrl ?? "") !== conversationId) {
      agent.conversationUrl = conversationUrlForStart(CHATGPT_START_URL, conversationId)
    }
    persistAgent(agent)
  }

  function captureConversationUrlFromPage(agent: BrowserAgentState): void {
    if (!agent.memory || agent.conversationUrl || !agent.page || agent.page.isClosed()) return
    const pageUrl = agent.page.url()
    if (extractConversationId(pageUrl)) agent.conversationUrl = pageUrl
  }

  function persistAgent(agent: BrowserAgentState): void {
    if (!agent.memory || !agent.conversationUrl) return
    state.store?.set(agent.agentId, { conversationUrl: agent.conversationUrl, turnCount: agent.turnCount, kind: agent.kind ?? "subagent" })
  }

  async function waitForInterTurn(agent: BrowserAgentState, signal?: AbortSignal): Promise<void> {
    if (agent.lastCompletedAt === undefined) return
    const remaining = agent.lastCompletedAt + MIN_INTER_TURN_DELAY_MS - Date.now()
    if (remaining > 0) await delay(remaining, signal)
  }

  function assertNotRateLimited(): void {
    if (Date.now() >= state.rateLimitedUntil) return
    throw new ChatGptSubagentError("SUBAGENT_RATE_LIMITED", RATE_LIMIT_ERROR_MESSAGE)
  }

  async function detectRateLimit(): Promise<void> {
    assertNotRateLimited()
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

  async function cleanupIdleAgents(now = Date.now()): Promise<void> {
    if (state.disposed) return
    for (const agent of state.agents.values()) {
      const activeOperation = state.activeOperations.get(agent.agentId)
      const activeTurn = typeof activeOperation === "string" ? state.turns.get(activeOperation) : undefined

      if (activeTurn?.status === "running") {
        if (now - activeTurn.lastActivityAt >= AGENT_IDLE_TTL_MS) {
          await failOrRecoverSubmittedTurn(
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

  function turnResult(turn: BrowserTurnState): ChatGptSubagentPollResult {
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

  return {
    connect: connectSubagents,
    ask: askSubagent,
    cloneSelf,
    cloneRun,
    poll: pollSubagent,
    drainEvents: drainPendingEvents,
    dispose: disposeSubagents,
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

export function appendFirstTurnMode(prompt: string, oververbosity: number): string {
  if (oververbosity === 5) return prompt
  const level = oververbosity === 1 ? "ultra" : oververbosity === 2 ? "full" : "lite"
  const qualifier = oververbosity === 4 ? " Favor completeness over terseness when useful." : ""
  return `${prompt}\n\n---\n\nSwitch to caveman ${level} mode. ${INJECTED_PROMPT}${qualifier}`
}
