import { join } from "node:path"
import type { Browser, BrowserContext, Page } from "playwright-core"

import { MCP_CONFIG } from "../../config.js"
import { type AgentIdentity, getAgentIdentity } from "../../server/agent-context.js"
import {
  assertAuthenticated,
  createBackgroundPage,
  delay,
  dismissBlockingChatGptOverlay,
  enterPrompt,
  extractConversationId,
  findComposer,
  forkLatestConversationTurn,
  isChatGptUrl,
  navigateAndCaptureConversationPayload,
  navigateChatGptPage,
  submitComposer,
  throwIfAborted,
  waitForPromise,
} from "./chatgpt-subagent-browser.js"
import {
  type ChatGptCloneRunRequest,
  type ChatGptCloneSelfRequest,
  type ChatGptSubagentActivity,
  type ChatGptSubagentCallContext,
  ChatGptSubagentError,
  type ChatGptSubagentPollResult,
  type ChatGptSubagentRequest,
  type ChatGptSubagentService,
} from "./chatgpt-subagent-contracts.js"
import {
  type AssistantResponseObservation,
  observeAssistantResponse,
} from "./chatgpt-subagent-observer.js"
import {
  extractConversationMessages,
  findLatestAssistantAfterPrompt,
} from "./chatgpt-subagent-protocol.js"
import { createSubagentStore } from "./subagent-store.js"

const AGENT_IDLE_TTL_MS = 30 * 60_000
const STALE_TURN_RECOVERY_MS = 3 * 60_000
const CLEANUP_INTERVAL_MS = 60_000
const CONNECT_TIMEOUT_MS = 3_000
const MIN_INTER_TURN_DELAY_MS = 1_500
const INTERACTION_DELAY_MS = 300
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000
const RATE_LIMIT_SELECTOR = '[data-testid="modal-conversation-history-rate-limit"]'
const RATE_LIMIT_DISMISS_SETTLE_MS = 250
const RATE_LIMIT_DISMISS_BUTTON_PATTERN = /got it|okay|ok|close/iu
const PROJECT_PATH_PATTERN = /\/g\/g-p-[^/]+\/project\/?$/u
const PROJECT_SUFFIX_PATTERN = /\/project\/?$/u
const CLONE_INITIAL_SETTLE_MS = 5_000
const RATE_LIMIT_ERROR_MESSAGE =
  "ChatGPT temporarily rate limited conversation access. New subagent turns are blocked during a 15-minute cooldown. Existing turns remain available through subagent_result. Do not retry automatically."
const SUBMISSION_GRACE_MS = 500
const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true"
const CHATGPT_START_URL = MCP_CONFIG.chatGpt.projectUrl

const INJECTED_PROMPT = `Oververbosity: 1.\n\nDo not use \`subagent\`${MCP_CONFIG.tools.computer ? " or `computer_*`" : ""} tools.`
type BrowserAgentStatus = "idle" | "uncertain" | ChatGptSubagentActivity

interface BrowserAgentState {
  agentId: string
  kind: "subagent" | "clone"
  memory: boolean
  status: BrowserAgentStatus
  page?: Page
  conversationUrl?: string
  lastCompletedAt?: number
  idleExpired?: boolean
  lastUsedAt: number
  turnCount: number
}

interface BrowserTurnState {
  turnId: string
  agentId: string
  parentAgent?: AgentIdentity
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

interface ActiveAgentOperation extends ChatGptSubagentCallContext {
  turnId?: string
}

interface SubagentScope {
  agents: Map<string, BrowserAgentState>
  turns: Map<string, BrowserTurnState>
  activeOperations: Map<string, ActiveAgentOperation>
  pendingEvents: string[]
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: The service is a cohesive closure over browser, agent, turn, and persistence state; splitting it would widen mutable state ownership.
export function createChatGptSubagentService(): ChatGptSubagentService {
  const store = createSubagentStore(join(MCP_CONFIG.stateDir, "subagents.sqlite"))
  const scopes = new Map<AgentIdentity | undefined, SubagentScope>()
  let rateLimitedUntil = 0
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let connectPromise: Promise<void> | undefined
  let disposed = false

  const cleanupTimer = setInterval(() => void cleanupIdleAgents(), CLEANUP_INTERVAL_MS)
  cleanupTimer.unref()

  async function askSubagent(
    request: ChatGptSubagentRequest,
    callContext: ChatGptSubagentCallContext
  ): Promise<string> {
    const parentAgent = getAgentIdentity()
    const scope = getScope(parentAgent)
    await beginAgentOperation(parentAgent, scope, request.agentId, callContext)
    let agent: BrowserAgentState | undefined
    let operationTransferred = false

    try {
      agent = scope.agents.get(request.agentId)
      if (!agent) {
        const memory = request.memory
        const persisted = memory ? store?.get(parentAgent, request.agentId) : undefined
        agent = {
          agentId: request.agentId,
          kind: persisted?.kind ?? "subagent",
          memory,
          status: "idle",
          lastUsedAt: Date.now(),
          turnCount: persisted?.turnCount ?? 0,
          conversationUrl: persisted?.conversationUrl,
        }
        await ensureAgentPage(scope, agent)
        scope.agents.set(agent.agentId, agent)
      }
      let submittedPrompt = request.prompt
      if (agent.turnCount === 0) submittedPrompt = `${request.prompt}\n\n---\n\n${INJECTED_PROMPT}`
      const turnId = await submitAgentTurn(parentAgent, scope, agent, submittedPrompt)
      operationTransferred = true
      return turnId
    } catch (error) {
      if (!operationTransferred && agent) agent.status = "idle"
      throw error
    } finally {
      if (!operationTransferred) scope.activeOperations.delete(request.agentId)
    }
  }

  async function cloneSelf(
    request: ChatGptCloneSelfRequest,
    callContext: ChatGptSubagentCallContext
  ): Promise<string> {
    const { signal } = callContext
    const parentAgent = getAgentIdentity()
    const scope = getScope(parentAgent)
    await beginAgentOperation(parentAgent, scope, request.cloneId, callContext)
    let sourcePage: Page | undefined
    let branchPage: Page | undefined
    let agent: BrowserAgentState | undefined
    let operationTransferred = false

    try {
      if (!isChatGptUrl(request.sourceConversationUrl)) {
        throw new ChatGptSubagentError(
          "AGENT_TARGET_LOST",
          "clone_self requires a chatgpt.com conversation URL."
        )
      }
      if (scope.agents.has(request.cloneId) || store?.get(parentAgent, request.cloneId)) {
        throw new ChatGptSubagentError("AGENT_BUSY", `Clone ${request.cloneId} already exists.`)
      }

      sourcePage = await createManagedPage()
      await navigateChatGptPage(sourcePage, request.sourceConversationUrl, signal)
      await assertAuthenticated(sourcePage)
      branchPage = await forkLatestConversationTurn(sourcePage, signal)
      if (branchPage !== sourcePage) await closePageIfOpen(sourcePage)
      sourcePage = undefined
      agent = {
        agentId: request.cloneId,
        kind: "clone",
        memory: true,
        status: "idle",
        page: branchPage,
        lastUsedAt: Date.now(),
        turnCount: 0,
      }
      scope.agents.set(agent.agentId, agent)

      await delay(CLONE_INITIAL_SETTLE_MS, signal)
      const turnId = await submitAgentTurn(parentAgent, scope, agent, request.prompt)
      operationTransferred = true
      return turnId
    } catch (error) {
      if (agent) scope.agents.delete(agent.agentId)
      await closePageIfOpen(branchPage)
      await closePageIfOpen(sourcePage)
      throw error
    } finally {
      if (!operationTransferred) scope.activeOperations.delete(request.cloneId)
    }
  }

  async function cloneRun(
    request: ChatGptCloneRunRequest,
    callContext: ChatGptSubagentCallContext
  ): Promise<string> {
    const parentAgent = getAgentIdentity()
    const scope = getScope(parentAgent)
    await beginAgentOperation(parentAgent, scope, request.cloneId, callContext)
    let agent: BrowserAgentState | undefined
    let operationTransferred = false

    try {
      agent = scope.agents.get(request.cloneId)
      if (!agent) {
        const persisted = store?.get(parentAgent, request.cloneId)
        if (persisted?.kind !== "clone") {
          throw new ChatGptSubagentError("AGENT_TARGET_LOST", `Unknown agent: ${request.cloneId}`)
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
        await ensureAgentPage(scope, agent)
        scope.agents.set(agent.agentId, agent)
      } else if (agent.kind !== "clone") {
        throw new ChatGptSubagentError("AGENT_TARGET_LOST", `${request.cloneId} is not a clone.`)
      }

      const turnId = await submitAgentTurn(parentAgent, scope, agent, request.prompt)
      operationTransferred = true
      return turnId
    } catch (error) {
      if (!operationTransferred && agent) agent.status = "idle"
      throw error
    } finally {
      if (!operationTransferred) scope.activeOperations.delete(request.cloneId)
    }
  }

  async function submitAgentTurn(
    parentAgent: AgentIdentity | undefined,
    scope: SubagentScope,
    agent: BrowserAgentState,
    submittedPrompt: string
  ): Promise<string> {
    const operation = scope.activeOperations.get(agent.agentId)
    if (!operation)
      throw new ChatGptSubagentError(
        "AGENT_BUSY",
        `Agent ${agent.agentId} has no active operation.`
      )
    const signal = operation.signal
    let observation: AssistantResponseObservation | undefined
    try {
      if (agent.lastCompletedAt !== undefined) {
        const remaining = agent.lastCompletedAt + MIN_INTER_TURN_DELAY_MS - Date.now()
        if (remaining > 0) await delay(remaining, signal)
      }
      const page = await ensureAgentPage(scope, agent)
      const turnId = `${agent.agentId}_turn_${agent.turnCount + 1}`
      const settlement = createTurnSettlement()
      const turn: BrowserTurnState = {
        turnId,
        agentId: agent.agentId,
        parentAgent,
        status: "running",
        recoveryAttempted: false,
        lastActivityAt: Date.now(),
        prompt: submittedPrompt,
        settled: settlement.promise,
        settle: settlement.resolve,
      }

      observation = await observeAssistantResponse(page, {
        prompt: submittedPrompt,
        onConversationId:
          agent.kind === "clone"
            ? undefined
            : (conversationId) => bindConversation(parentAgent, agent, conversationId),
        onActivity: (activity) => {
          if (activity) agent.status = activity
          turn.lastActivityAt = Date.now()
        },
      })

      await dismissBlockingChatGptOverlay(page, signal)
      const composer = await findComposer(page, signal)
      await delay(INTERACTION_DELAY_MS, signal)
      assertAgentPage(page, agent)
      await enterPrompt(page, composer, submittedPrompt, signal)
      await delay(INTERACTION_DELAY_MS, signal)
      assertAgentPage(page, agent)
      await delay(SUBMISSION_GRACE_MS, signal)
      await detectRateLimit()
      await submitComposer(page, composer, signal)

      if (agent.status === "idle") agent.status = "Working"
      agent.lastUsedAt = Date.now()
      agent.turnCount += 1
      persistAgent(parentAgent, agent)
      turn.observation = observation
      scope.turns.set(turnId, turn)
      operation.turnId = turnId
      operation.signal = undefined
      observation = undefined

      void waitForTurnResponse(turn)
      return turnId
    } catch (error) {
      await observation?.dispose().catch(() => undefined)
      throw error
    }
  }

  async function pollSubagent(
    turnId: string,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<ChatGptSubagentPollResult> {
    const parentAgent = getAgentIdentity()
    const scope = scopes.get(parentAgent)
    const turn = scope?.turns.get(turnId)
    if (!turn) throw new ChatGptSubagentError("UNKNOWN_TURN", `Unknown agent turn: ${turnId}`)
    if (turn.status === "running" && waitMs > 0) {
      let timer: NodeJS.Timeout | undefined
      await waitForPromise(
        Promise.race([
          turn.settled,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, waitMs)
          }),
        ]),
        signal
      ).finally(() => {
        if (timer) clearTimeout(timer)
      })
    }
    throwIfAborted(signal)
    const agentStatus = scope?.agents.get(turn.agentId)?.status
    const activity = agentStatus === "idle" || agentStatus === "uncertain" ? undefined : agentStatus
    return {
      status: turn.status,
      activity: turn.status === "running" ? activity : undefined,
      activityAgeMs:
        turn.status === "running" ? Math.max(0, Date.now() - turn.lastActivityAt) : undefined,
      response: turn.response,
      errorCode: turn.errorCode,
      errorMessage: turn.errorMessage,
    }
  }

  async function ensureAgentPage(scope: SubagentScope, agent: BrowserAgentState): Promise<Page> {
    const signal = scope.activeOperations.get(agent.agentId)?.signal
    throwIfAborted(signal)
    const page = agent.page && !agent.page.isClosed() ? agent.page : undefined
    if (agent.turnCount > 0) captureConversationUrlFromPage(agent)
    if (page && isExpectedAgentPage(page, agent)) return page
    const targetUrl = agentTargetUrl(agent)
    if (!targetUrl) {
      throw new ChatGptSubagentError(
        "AGENT_TARGET_LOST",
        `Agent ${agent.agentId} lost its page before its conversation URL was saved.`
      )
    }

    const created = !page
    const restoredPage = page ?? (await createManagedPage())
    try {
      await navigateChatGptPage(restoredPage, targetUrl, signal)
      await assertAuthenticated(restoredPage)
      assertAgentPage(restoredPage, agent)
      await findComposer(restoredPage, signal)
      agent.page = restoredPage
      agent.lastUsedAt = Date.now()
      return restoredPage
    } catch (error) {
      if (created) await closePageIfOpen(restoredPage)
      throw error
    }
  }

  async function waitForTurnResponse(turn: BrowserTurnState): Promise<void> {
    const observation = turn.observation
    if (!observation) return
    try {
      const result = await observation.response
      if (disposed || turn.status !== "running" || turn.observation !== observation) return
      const agent = scopes.get(turn.parentAgent)?.agents.get(turn.agentId)
      if (!agent) return
      if (agent.kind !== "clone" && result.conversationId)
        bindConversation(turn.parentAgent, agent, result.conversationId)
      completeTurn(turn, result.text)
    } catch (error) {
      if (disposed || turn.status !== "running" || turn.observation !== observation) return
      await failOrRecoverSubmittedTurn(turn, error)
    }
  }

  async function failOrRecoverSubmittedTurn(
    turn: BrowserTurnState,
    originalError: unknown
  ): Promise<void> {
    if (turn.status !== "running") return

    const oldObservation = turn.observation
    turn.observation = undefined
    await oldObservation?.dispose().catch(() => undefined)

    const agent = scopes.get(turn.parentAgent)?.agents.get(turn.agentId)
    if (!agent) {
      failTurn(turn, originalError)
      return
    }

    captureConversationUrlFromPage(agent)

    let failure = originalError
    if (!turn.recoveryAttempted && agent.conversationUrl) {
      turn.recoveryAttempted = true
      turn.lastActivityAt = Date.now()
      agent.status = "Working"
      try {
        if (await recoverSubmittedTurn(turn)) return
      } catch (recoveryError) {
        failure = recoveryError
      }
    }

    agent.status = "uncertain"
    failTurn(turn, failure)
  }

  async function recoverSubmittedTurn(turn: BrowserTurnState): Promise<boolean> {
    const agent = scopes.get(turn.parentAgent)?.agents.get(turn.agentId)
    if (!agent)
      throw new ChatGptSubagentError("AGENT_TARGET_LOST", `Agent ${turn.agentId} no longer exists.`)
    const conversationUrl = agent.conversationUrl
    const conversationId = conversationUrl ? extractConversationId(conversationUrl) : undefined
    if (!conversationUrl || !conversationId) {
      throw new ChatGptSubagentError(
        "AGENT_TARGET_LOST",
        `Agent ${agent.agentId} has no saved conversation to recover.`
      )
    }

    const oldPage = agent.page
    if (oldPage && !oldPage.isClosed() && extractConversationId(oldPage.url()) === conversationId) {
      const payload = await oldPage
        .evaluate(async (id) => {
          const response = await fetch(`/backend-api/conversations/${encodeURIComponent(id)}`)
          return response.ok ? response.json() : undefined
        }, conversationId)
        .catch(() => undefined)
      const answer = findLatestAssistantAfterPrompt(
        extractConversationMessages(payload),
        turn.prompt,
        agent.turnCount
      )
      if (answer) {
        completeTurn(turn, answer.text)
        return true
      }
    }

    const page = await createManagedPage()
    try {
      const payload = await navigateAndCaptureConversationPayload(page, conversationUrl)
      await assertAuthenticated(page)
      assertAgentPage(page, agent)
      await findComposer(page)

      agent.page = page
      agent.lastUsedAt = Date.now()
      await closePageIfOpen(oldPage)

      const answer = findLatestAssistantAfterPrompt(
        extractConversationMessages(payload),
        turn.prompt,
        agent.turnCount
      )
      if (!answer) return false
      completeTurn(turn, answer.text)
      return true
    } catch (error) {
      if (agent.page !== page) await closePageIfOpen(page)
      throw error
    }
  }

  async function disposeSubagents(): Promise<void> {
    disposed = true
    clearInterval(cleanupTimer)
    const connectedBrowser = browser
    const allTurns = [...scopes.values()].flatMap((scope) => [...scope.turns.values()])
    const allAgents = [...scopes.values()].flatMap((scope) => [...scope.agents.values()])
    const observations = allTurns
      .map((turn) => turn.observation)
      .filter((value): value is AssistantResponseObservation => value !== undefined)
    const pages = allAgents
      .map((agent) => agent.page)
      .filter((page): page is Page => page !== undefined && !page.isClosed())
    for (const turn of allTurns) turn.settle()
    scopes.clear()
    context = undefined
    browser = undefined
    connectPromise = undefined
    store?.close()
    await Promise.allSettled([
      ...observations.map((observation) => observation.dispose()),
      ...pages.map((page) => page.close()),
    ])
    await connectedBrowser?.close().catch(() => undefined)
  }

  async function beginAgentOperation(
    parentAgent: AgentIdentity | undefined,
    scope: SubagentScope,
    agentId: string,
    callContext: ChatGptSubagentCallContext
  ): Promise<void> {
    assertNotRateLimited()
    const agent = scope.agents.get(agentId)
    assertAgentOperationAvailable(scope, agentId, agent)
    assertDelegatedAgentSlotAvailable(parentAgent, scope, agentId)
    const operation: ActiveAgentOperation = { ...callContext }
    scope.activeOperations.set(agentId, operation)

    try {
      const { signal } = callContext
      throwIfAborted(signal)
      await ensureBrowserConnection(signal)
      if (await clearExpiredRateLimit(signal)) return
      await detectRateLimit()
    } catch (error) {
      if (scope.activeOperations.get(agentId) === operation) scope.activeOperations.delete(agentId)
      throw error
    }
  }

  function assertAgentOperationAvailable(
    scope: SubagentScope,
    agentId: string,
    agent: BrowserAgentState | undefined
  ): void {
    if (agent?.idleExpired) {
      throw new ChatGptSubagentError(
        "TEMP_AGENT_EXPIRED",
        `Temporary agent ${agentId} was closed after 30 minutes of inactivity. Its conversation cannot be resumed.`
      )
    }
    if (scope.activeOperations.has(agentId)) {
      throw new ChatGptSubagentError("AGENT_BUSY", `Agent ${agentId} already has an active turn.`)
    }
    if (agent?.status === "uncertain") {
      throw new ChatGptSubagentError(
        "AGENT_BUSY",
        `Agent ${agentId} has uncertain upstream state after recovery could not confirm completion. Use another existing agent ID, or a new ID if a delegated-agent slot is available.`
      )
    }
    if (agent && agent.status !== "idle") {
      throw new ChatGptSubagentError("AGENT_BUSY", `Agent ${agentId} is still ${agent.status}.`)
    }
  }

  async function ensureBrowserConnection(signal?: AbortSignal): Promise<void> {
    if (browser?.isConnected() && context) return
    connectPromise ??= connectBrowser().finally(() => {
      connectPromise = undefined
    })
    await waitForPromise(connectPromise, signal)
  }

  async function connectBrowser(): Promise<void> {
    try {
      const { chromium } = await import("playwright-core")
      browser = await chromium.connectOverCDP(MCP_CONFIG.chatGpt.cdpEndpoint, {
        timeout: CONNECT_TIMEOUT_MS,
      })
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: ChatGptSubagentError accepts ErrorOptions as its third argument and forwards the cause to Error.
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
    const [browserContext] = browser.contexts()
    if (!browserContext) {
      throw new ChatGptSubagentError(
        "BROWSER_UNAVAILABLE",
        "Connected Chrome instance did not expose a browser context."
      )
    }
    context = browserContext
  }

  async function clearExpiredRateLimit(signal?: AbortSignal): Promise<boolean> {
    if (rateLimitedUntil <= 0) return false
    if (Date.now() < rateLimitedUntil) return true
    const pages = (context?.pages() ?? []).filter((page) => isChatGptUrl(page.url()))
    await Promise.all(pages.map((page) => dismissRateLimitModal(page, signal)))
    rateLimitedUntil = 0
    return true
  }

  async function dismissRateLimitModal(page: Page, signal?: AbortSignal): Promise<void> {
    const modal = page.locator(RATE_LIMIT_SELECTOR).first()
    if (!(await modal.isVisible().catch(() => false))) return
    const button = modal.getByRole("button", { name: RATE_LIMIT_DISMISS_BUTTON_PATTERN }).first()
    await button.click().catch(() => page.keyboard.press("Escape"))
    await delay(RATE_LIMIT_DISMISS_SETTLE_MS, signal)
  }

  function completeTurn(turn: BrowserTurnState, response: string): void {
    if (turn.status !== "running") return
    const scope = scopes.get(turn.parentAgent)
    if (!scope) {
      failTurn(
        turn,
        new ChatGptSubagentError("AGENT_TARGET_LOST", `Agent ${turn.agentId} no longer exists.`)
      )
      return
    }
    const agent = scope.agents.get(turn.agentId)
    if (!agent) {
      failTurn(
        turn,
        new ChatGptSubagentError("AGENT_TARGET_LOST", `Agent ${turn.agentId} no longer exists.`)
      )
      return
    }
    const now = Date.now()
    captureConversationUrlFromPage(agent)
    persistAgent(turn.parentAgent, agent)
    agent.lastCompletedAt = now
    agent.lastUsedAt = now
    agent.status = "idle"
    turn.status = "completed"
    turn.response = response
    settleTurn(turn)
    scope.pendingEvents.push(`agent_finished agent_id=${turn.agentId} turn_id=${turn.turnId}`)
  }

  function drainPendingEvents(): string[] {
    const agent = getAgentIdentity()
    // The first drain after a restart creates the scope so start_here can surface persisted agents immediately.
    const scope = getScope(agent)
    if (scope.pendingEvents.length === 0) return []
    return scope.pendingEvents.splice(0)
  }

  function failTurn(turn: BrowserTurnState, error: unknown): void {
    if (turn.status !== "running") return
    turn.status = "failed"
    turn.errorCode = error instanceof ChatGptSubagentError ? error.code : "subagent_failed"
    turn.errorMessage = error instanceof Error ? error.message : String(error)
    settleTurn(turn)
  }

  function settleTurn(turn: BrowserTurnState): void {
    void turn.observation?.dispose().catch(() => undefined)
    turn.observation = undefined
    const scope = scopes.get(turn.parentAgent)
    if (scope?.activeOperations.get(turn.agentId)?.turnId === turn.turnId)
      scope.activeOperations.delete(turn.agentId)
    turn.settle()
  }

  async function createManagedPage(): Promise<Page> {
    if (!browser || !context)
      throw new ChatGptSubagentError("BROWSER_UNAVAILABLE", "ChatGPT browser is not connected.")
    return createBackgroundPage(browser, context)
  }

  function assertAgentPage(page: Page, agent: BrowserAgentState): void {
    if (isExpectedAgentPage(page, agent)) return
    throw new ChatGptSubagentError(
      "AGENT_TARGET_LOST",
      `Agent ${agent.agentId} no longer owns a usable ChatGPT page.`
    )
  }

  function isExpectedAgentPage(page: Page, agent: BrowserAgentState): boolean {
    if (page.isClosed() || !isChatGptUrl(page.url())) return false
    const currentConversationId = extractConversationId(page.url())
    const expectedConversationId = agent.conversationUrl
      ? extractConversationId(agent.conversationUrl)
      : undefined
    return expectedConversationId
      ? currentConversationId === expectedConversationId
      : currentConversationId === undefined
  }

  function bindConversation(
    parentAgent: AgentIdentity | undefined,
    agent: BrowserAgentState,
    conversationId: string
  ): void {
    if (!agent.memory) return
    const pageUrl = agent.page && !agent.page.isClosed() ? agent.page.url() : undefined
    if (pageUrl && extractConversationId(pageUrl) === conversationId)
      agent.conversationUrl = pageUrl
    else if (extractConversationId(agent.conversationUrl ?? "") !== conversationId) {
      const url = new URL(CHATGPT_START_URL)
      const encodedId = encodeURIComponent(conversationId)
      if (PROJECT_PATH_PATTERN.test(url.pathname)) {
        url.pathname = `${url.pathname.replace(PROJECT_SUFFIX_PATTERN, "")}/c/${encodedId}`
        url.search = ""
        url.hash = ""
        agent.conversationUrl = url.toString()
      } else {
        agent.conversationUrl = `https://chatgpt.com/c/${encodedId}`
      }
    }
    persistAgent(parentAgent, agent)
  }

  function captureConversationUrlFromPage(agent: BrowserAgentState): void {
    if (!agent.memory || agent.conversationUrl || !agent.page || agent.page.isClosed()) return
    const pageUrl = agent.page.url()
    if (extractConversationId(pageUrl)) agent.conversationUrl = pageUrl
  }

  function persistAgent(parentAgent: AgentIdentity | undefined, agent: BrowserAgentState): void {
    if (!agent.memory || !agent.conversationUrl) return
    store?.set(parentAgent, agent.agentId, {
      conversationUrl: agent.conversationUrl,
      turnCount: agent.turnCount,
      kind: agent.kind,
    })
  }

  function assertDelegatedAgentSlotAvailable(
    parentAgent: AgentIdentity | undefined,
    scope: SubagentScope,
    requestedAgentId: string
  ): void {
    const agents = new Map<string, string | undefined>()

    for (const persisted of store?.list(parentAgent) ?? []) {
      agents.set(
        persisted.agentId,
        persisted.turnCount > 0 ? `${persisted.agentId}_turn_${persisted.turnCount}` : undefined
      )
    }
    for (const agent of scope.agents.values()) {
      const activeTurnId = scope.activeOperations.get(agent.agentId)?.turnId
      agents.set(
        agent.agentId,
        activeTurnId ??
          (agent.turnCount > 0 ? `${agent.agentId}_turn_${agent.turnCount}` : undefined)
      )
    }
    for (const [agentId, operation] of scope.activeOperations) {
      if (!agents.has(agentId)) agents.set(agentId, operation.turnId)
    }

    if (agents.has(requestedAgentId) || agents.size < MCP_CONFIG.chatGpt.maxDelegatedAgents) return

    const existing = [...agents.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([existingAgentId, turnId]) => `${existingAgentId} (latest_turn_id=${turnId ?? "pending"})`
      )
      .join(", ")
    throw new ChatGptSubagentError(
      "AGENT_LIMIT_REACHED",
      `This main agent already has the maximum ${MCP_CONFIG.chatGpt.maxDelegatedAgents} delegated agents. Reuse one of these agent IDs: ${existing}.`
    )
  }

  function assertNotRateLimited(): void {
    if (Date.now() >= rateLimitedUntil) return
    throw new ChatGptSubagentError("SUBAGENT_RATE_LIMITED", RATE_LIMIT_ERROR_MESSAGE)
  }

  async function detectRateLimit(): Promise<void> {
    assertNotRateLimited()
    for (const page of context?.pages() ?? []) {
      if (!isChatGptUrl(page.url())) continue
      const visible = await page
        .locator(RATE_LIMIT_SELECTOR)
        .first()
        .isVisible()
        .catch(() => false)
      if (!visible) continue
      rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
      throw new ChatGptSubagentError("SUBAGENT_RATE_LIMITED", RATE_LIMIT_ERROR_MESSAGE)
    }
  }

  async function cleanupIdleAgents(): Promise<void> {
    if (disposed) return
    const now = Date.now()
    const entries = [...scopes.values()].flatMap((scope) =>
      [...scope.agents.values()].map((agent) => ({ scope, agent }))
    )
    await entries.reduce(
      (previous, entry) => previous.then(() => cleanupIdleAgent(entry.scope, entry.agent, now)),
      Promise.resolve()
    )
  }

  async function cleanupIdleAgent(
    scope: SubagentScope,
    agent: BrowserAgentState,
    now: number
  ): Promise<void> {
    const activeOperation = scope.activeOperations.get(agent.agentId)
    const activeTurn = activeOperation?.turnId ? scope.turns.get(activeOperation.turnId) : undefined
    if (activeTurn?.status === "running") {
      await recoverExpiredTurn(agent, activeTurn, now)
      return
    }
    if (
      (activeOperation && !activeOperation.turnId) ||
      now - agent.lastUsedAt < AGENT_IDLE_TTL_MS
    ) {
      return
    }
    const page = agent.page
    if (!page || page.isClosed()) return
    if (!agent.memory) agent.idleExpired = true
    await page.close().catch(() => undefined)
    if (agent.page === page) agent.page = undefined
  }

  async function recoverExpiredTurn(
    agent: BrowserAgentState,
    turn: BrowserTurnState,
    now: number
  ): Promise<void> {
    const idleMs = now - turn.lastActivityAt
    if (agent.memory && !turn.recoveryAttempted && idleMs >= STALE_TURN_RECOVERY_MS) {
      await failOrRecoverSubmittedTurn(
        turn,
        new ChatGptSubagentError(
          "AGENT_IDLE_EXPIRED",
          "Agent turn had no observable progress for 3 minutes."
        )
      )
      return
    }
    if (idleMs >= AGENT_IDLE_TTL_MS) {
      await failOrRecoverSubmittedTurn(
        turn,
        new ChatGptSubagentError(
          "AGENT_IDLE_EXPIRED",
          "Agent turn expired after 30 minutes without observable progress."
        )
      )
    }
  }

  return {
    ask: askSubagent,
    cloneSelf,
    cloneRun,
    poll: pollSubagent,
    drainEvents: drainPendingEvents,
    dispose: disposeSubagents,
  }

  function getScope(parentAgent: AgentIdentity | undefined): SubagentScope {
    const existing = scopes.get(parentAgent)
    if (existing) return existing
    const scope: SubagentScope = {
      agents: new Map(),
      turns: new Map(),
      activeOperations: new Map(),
      // Runtime turn state is not persisted, but these conversation IDs can still be reused for the next turn.
      pendingEvents: (store?.list(parentAgent) ?? [])
        .filter((agent) => agent.turnCount > 0)
        .map(
          (agent) =>
            `existing_agent agent_id=${agent.agentId} latest_turn_id=${agent.agentId}_turn_${agent.turnCount}`
        ),
    }
    scopes.set(parentAgent, scope)
    return scope
  }
}

function createTurnSettlement(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function agentTargetUrl(agent: BrowserAgentState): string | undefined {
  if (agent.conversationUrl) return agent.conversationUrl
  if (agent.turnCount !== 0) return undefined
  return agent.memory ? CHATGPT_START_URL : TEMPORARY_CHAT_URL
}

async function closePageIfOpen(page: Page | undefined): Promise<void> {
  if (!page || page.isClosed()) return
  await page.close().catch(() => undefined)
}
