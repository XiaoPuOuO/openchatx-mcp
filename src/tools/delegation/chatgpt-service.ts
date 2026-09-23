import type { Browser, BrowserContext, Page } from "playwright-core"

import { type AgentIdentity, getAgentIdentity } from "../../agent/context.js"
import { MCP_CONFIG } from "../../config.js"
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
} from "./chatgpt-browser.js"
import {
  type ChatGptCloneRunRequest,
  type ChatGptCloneSelfRequest,
  type ChatGptDelegationCallContext,
  ChatGptDelegationError,
  type ChatGptDelegationPollResult,
  type ChatGptDelegationService,
  type ChatGptSubagentRequest,
} from "./contracts.js"
import {
  type ActiveAgentOperation,
  type BrowserAgentState,
  type BrowserTurnState,
  DelegationLifecycle,
} from "./lifecycle.js"
import { type AssistantResponseObservation, observeAssistantResponse } from "./response-observer.js"
import { extractConversationMessages, findLatestAssistantAfterPrompt } from "./turn-protocol.js"

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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Browser submission, observation, and recovery stay together while mutable lifecycle bookkeeping lives in DelegationLifecycle.
export function createChatGptDelegationService(): ChatGptDelegationService {
  const lifecycle = new DelegationLifecycle()
  let rateLimitedUntil = 0
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let connectPromise: Promise<void> | undefined

  const cleanupTimer = setInterval(() => void cleanupIdleAgents(), CLEANUP_INTERVAL_MS)
  cleanupTimer.unref()

  async function askSubagent(
    request: ChatGptSubagentRequest,
    callContext: ChatGptDelegationCallContext
  ): Promise<string> {
    const parentAgent = getAgentIdentity()
    const operation = await beginAgentOperation(parentAgent, request.agentId, callContext)
    let agent: BrowserAgentState | undefined
    let operationTransferred = false

    try {
      agent = lifecycle.getAgent(parentAgent, request.agentId)
      if (!agent) {
        agent = lifecycle.createSubagentAgent(
          parentAgent,
          request.agentId,
          request.memory,
          Date.now()
        )
        await ensureAgentPage(parentAgent, agent)
        lifecycle.registerAgent(parentAgent, agent)
      }
      let submittedPrompt = request.prompt
      if (agent.turnCount === 0) submittedPrompt = `${request.prompt}\n\n---\n\n${INJECTED_PROMPT}`
      const turnId = await submitAgentTurn(parentAgent, agent, submittedPrompt)
      operationTransferred = true
      return turnId
    } catch (error) {
      if (!operationTransferred && agent) lifecycle.resetUnsubmittedAgent(agent)
      throw error
    } finally {
      if (!operationTransferred) lifecycle.releaseOperation(parentAgent, request.agentId, operation)
    }
  }

  async function cloneSelf(
    request: ChatGptCloneSelfRequest,
    callContext: ChatGptDelegationCallContext
  ): Promise<string> {
    const { signal } = callContext
    const parentAgent = getAgentIdentity()
    const operation = await beginAgentOperation(parentAgent, request.cloneId, callContext)
    let sourcePage: Page | undefined
    let branchPage: Page | undefined
    let agent: BrowserAgentState | undefined
    let operationTransferred = false

    try {
      if (!isChatGptUrl(request.sourceConversationUrl)) {
        throw new ChatGptDelegationError(
          "AGENT_TARGET_LOST",
          "clone_self requires a chatgpt.com conversation URL."
        )
      }
      lifecycle.assertCloneAvailable(parentAgent, request.cloneId)

      sourcePage = await createManagedPage()
      await navigateChatGptPage(sourcePage, request.sourceConversationUrl, signal)
      await assertAuthenticated(sourcePage)
      branchPage = await forkLatestConversationTurn(sourcePage, signal)
      if (branchPage !== sourcePage) await closePageIfOpen(sourcePage)
      sourcePage = undefined
      agent = lifecycle.createCloneAgent(request.cloneId, branchPage, Date.now())
      lifecycle.registerAgent(parentAgent, agent)

      await delay(CLONE_INITIAL_SETTLE_MS, signal)
      const turnId = await submitAgentTurn(parentAgent, agent, request.prompt)
      operationTransferred = true
      return turnId
    } catch (error) {
      if (agent) lifecycle.removeAgent(parentAgent, agent)
      await closePageIfOpen(branchPage)
      await closePageIfOpen(sourcePage)
      throw error
    } finally {
      if (!operationTransferred) lifecycle.releaseOperation(parentAgent, request.cloneId, operation)
    }
  }

  async function cloneRun(
    request: ChatGptCloneRunRequest,
    callContext: ChatGptDelegationCallContext
  ): Promise<string> {
    const parentAgent = getAgentIdentity()
    const operation = await beginAgentOperation(parentAgent, request.cloneId, callContext)
    let agent: BrowserAgentState | undefined
    let operationTransferred = false

    try {
      agent = lifecycle.getAgent(parentAgent, request.cloneId)
      if (!agent) {
        agent = lifecycle.createRestoredCloneAgent(parentAgent, request.cloneId, Date.now())
        await ensureAgentPage(parentAgent, agent)
        lifecycle.registerAgent(parentAgent, agent)
      } else if (agent.kind !== "clone") {
        throw new ChatGptDelegationError("AGENT_TARGET_LOST", `${request.cloneId} is not a clone.`)
      }

      const turnId = await submitAgentTurn(parentAgent, agent, request.prompt)
      operationTransferred = true
      return turnId
    } catch (error) {
      if (!operationTransferred && agent) lifecycle.resetUnsubmittedAgent(agent)
      throw error
    } finally {
      if (!operationTransferred) lifecycle.releaseOperation(parentAgent, request.cloneId, operation)
    }
  }

  async function submitAgentTurn(
    parentAgent: AgentIdentity | undefined,
    agent: BrowserAgentState,
    submittedPrompt: string
  ): Promise<string> {
    const signal = lifecycle.requireOperationSignal(parentAgent, agent.agentId)
    let observation: AssistantResponseObservation | undefined
    try {
      if (agent.lastCompletedAt !== undefined) {
        const remaining = agent.lastCompletedAt + MIN_INTER_TURN_DELAY_MS - Date.now()
        if (remaining > 0) await delay(remaining, signal)
      }
      const page = await ensureAgentPage(parentAgent, agent)
      const turn = lifecycle.createTurn(parentAgent, agent, submittedPrompt, Date.now())

      observation = await observeAssistantResponse(page, {
        prompt: submittedPrompt,
        onConversationId:
          agent.kind === "clone"
            ? undefined
            : (conversationId) => bindConversation(parentAgent, agent, conversationId),
        onActivity: (activity) => lifecycle.recordActivity(agent, turn, activity, Date.now()),
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

      lifecycle.recordSubmittedTurn(parentAgent, agent, turn, observation, Date.now())
      observation = undefined

      void waitForTurnResponse(turn)
      return turn.turnId
    } catch (error) {
      await observation?.dispose().catch(() => undefined)
      throw error
    }
  }

  async function pollSubagent(
    turnId: string,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<ChatGptDelegationPollResult> {
    const parentAgent = getAgentIdentity()
    const turn = lifecycle.requireTurn(parentAgent, turnId)
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
    return lifecycle.pollResult(parentAgent, turn, Date.now())
  }

  async function ensureAgentPage(
    parentAgent: AgentIdentity | undefined,
    agent: BrowserAgentState
  ): Promise<Page> {
    const signal = lifecycle.operationSignal(parentAgent, agent.agentId)
    throwIfAborted(signal)
    const page = agent.page && !agent.page.isClosed() ? agent.page : undefined
    if (agent.turnCount > 0) captureConversationUrlFromPage(agent)
    if (page && isExpectedAgentPage(page, agent)) return page
    const targetUrl = agentTargetUrl(agent)
    if (!targetUrl) {
      throw new ChatGptDelegationError(
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
      if (lifecycle.isDisposed || turn.status !== "running" || turn.observation !== observation)
        return
      const agent = lifecycle.agentForTurn(turn)
      if (!agent) return
      if (agent.kind !== "clone" && result.conversationId)
        bindConversation(turn.parentAgent, agent, result.conversationId)
      completeTurn(turn, result.text)
    } catch (error) {
      if (lifecycle.isDisposed || turn.status !== "running" || turn.observation !== observation)
        return
      await failOrRecoverSubmittedTurn(turn, error)
    }
  }

  async function failOrRecoverSubmittedTurn(
    turn: BrowserTurnState,
    originalError: unknown
  ): Promise<void> {
    if (turn.status !== "running") return

    const oldObservation = lifecycle.detachObservation(turn)
    await oldObservation?.dispose().catch(() => undefined)

    const agent = lifecycle.agentForTurn(turn)
    if (!agent) {
      failTurn(turn, originalError)
      return
    }

    captureConversationUrlFromPage(agent)

    let failure = originalError
    if (lifecycle.startRecovery(turn, agent, Date.now())) {
      try {
        if (await recoverSubmittedTurn(turn)) return
      } catch (recoveryError) {
        failure = recoveryError
      }
    }

    lifecycle.markUncertain(agent)
    failTurn(turn, failure)
  }

  async function recoverSubmittedTurn(turn: BrowserTurnState): Promise<boolean> {
    const agent = lifecycle.agentForTurn(turn)
    if (!agent)
      throw new ChatGptDelegationError(
        "AGENT_TARGET_LOST",
        `Agent ${turn.agentId} no longer exists.`
      )
    const conversationUrl = agent.conversationUrl
    const conversationId = conversationUrl ? extractConversationId(conversationUrl) : undefined
    if (!conversationUrl || !conversationId) {
      throw new ChatGptDelegationError(
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
    clearInterval(cleanupTimer)
    const connectedBrowser = browser
    const { agents, observations } = lifecycle.dispose()
    const pages = agents
      .map((agent) => agent.page)
      .filter((page): page is Page => page !== undefined && !page.isClosed())
    context = undefined
    browser = undefined
    connectPromise = undefined
    await Promise.allSettled([
      ...observations.map((observation) => observation.dispose()),
      ...pages.map((page) => page.close()),
    ])
    await connectedBrowser?.close().catch(() => undefined)
  }

  async function beginAgentOperation(
    parentAgent: AgentIdentity | undefined,
    agentId: string,
    callContext: ChatGptDelegationCallContext
  ): Promise<ActiveAgentOperation> {
    assertNotRateLimited()
    const operation = lifecycle.reserveOperation(parentAgent, agentId, callContext)

    try {
      const { signal } = callContext
      throwIfAborted(signal)
      await ensureBrowserConnection(signal)
      if (await clearExpiredRateLimit(signal)) return operation
      await detectRateLimit()
      return operation
    } catch (error) {
      lifecycle.releaseOperation(parentAgent, agentId, operation)
      throw error
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
      // biome-ignore lint/style/useErrorCause: ChatGptDelegationError accepts ErrorOptions as its third argument and forwards the cause to Error.
      throw new ChatGptDelegationError(
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
      throw new ChatGptDelegationError(
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
    const agent = lifecycle.agentForTurn(turn)
    if (!agent) {
      failTurn(
        turn,
        new ChatGptDelegationError("AGENT_TARGET_LOST", `Agent ${turn.agentId} no longer exists.`)
      )
      return
    }
    captureConversationUrlFromPage(agent)
    lifecycle.persistAgent(turn.parentAgent, agent)
    disposeSettledObservation(lifecycle.completeTurn(turn, response, Date.now()))
  }

  function drainPendingEvents(): string[] {
    return lifecycle.drainEvents(getAgentIdentity())
  }

  function failTurn(turn: BrowserTurnState, error: unknown): void {
    disposeSettledObservation(lifecycle.failTurn(turn, error))
  }

  function disposeSettledObservation(observation: AssistantResponseObservation | undefined): void {
    void observation?.dispose().catch(() => undefined)
  }

  async function createManagedPage(): Promise<Page> {
    if (!browser || !context)
      throw new ChatGptDelegationError("BROWSER_UNAVAILABLE", "ChatGPT browser is not connected.")
    return createBackgroundPage(browser, context)
  }

  function assertAgentPage(page: Page, agent: BrowserAgentState): void {
    if (isExpectedAgentPage(page, agent)) return
    throw new ChatGptDelegationError(
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
    lifecycle.persistAgent(parentAgent, agent)
  }

  function captureConversationUrlFromPage(agent: BrowserAgentState): void {
    if (!agent.memory || agent.conversationUrl || !agent.page || agent.page.isClosed()) return
    const pageUrl = agent.page.url()
    if (extractConversationId(pageUrl)) agent.conversationUrl = pageUrl
  }

  function assertNotRateLimited(): void {
    if (Date.now() >= rateLimitedUntil) return
    throw new ChatGptDelegationError("SUBAGENT_RATE_LIMITED", RATE_LIMIT_ERROR_MESSAGE)
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
      throw new ChatGptDelegationError("SUBAGENT_RATE_LIMITED", RATE_LIMIT_ERROR_MESSAGE)
    }
  }

  async function cleanupIdleAgents(): Promise<void> {
    if (lifecycle.isDisposed) return
    for (const action of lifecycle.idleCleanupActions(Date.now())) {
      if (action.kind === "recover") {
        await failOrRecoverSubmittedTurn(action.turn, action.error)
      } else {
        let closed = action.page.isClosed()
        if (!closed) {
          try {
            await action.page.close()
            closed = true
          } catch {
            closed = action.page.isClosed()
          }
        }
        if (closed) lifecycle.commitIdlePageClosed(action.agent, action.page)
      }
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
