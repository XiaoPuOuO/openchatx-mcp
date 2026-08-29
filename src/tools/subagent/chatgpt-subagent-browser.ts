import type { Browser, BrowserContext, Locator, Page } from "playwright-core"

import { ChatGptSubagentError } from "./chatgpt-subagent-contracts.js"

const BACKGROUND_PAGE_BIND_TIMEOUT_MS = 5_000
const CHATGPT_OPERATION_TIMEOUT_MS = 120_000
const COMPOSER_SELECTORS = [
  "#prompt-textarea",
  '[data-testid="prompt-textarea"]',
  '[contenteditable="true"][aria-label*="Chat with ChatGPT" i]',
  '[contenteditable="true"][aria-label*="Ask ChatGPT" i]',
  'textarea[placeholder*="Ask ChatGPT" i]:not(.wcDTda_fallbackTextarea)',
] as const

const LATEST_FORKABLE_TURN_SELECTOR = 'section[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])'

export async function createBackgroundPage(browser: Browser, context: BrowserContext): Promise<Page> {
  const knownPages = new Set(context.pages())
  const session = await browser.newBrowserCDPSession()
  let targetId: string | undefined
  try {
    const created = await session.send("Target.createTarget", { url: "about:blank", background: true, focus: false })
    targetId = created.targetId
    const deadline = Date.now() + BACKGROUND_PAGE_BIND_TIMEOUT_MS
    while (Date.now() < deadline) {
      for (const page of context.pages()) {
        if (knownPages.has(page) || page.isClosed()) continue
        if ((await pageTargetId(context, page)) === targetId) return page
      }
      await delay(25)
    }
    throw new ChatGptSubagentError("BROWSER_UNAVAILABLE", `Chrome created background target ${targetId}, but Playwright did not expose it.`)
  } catch (error) {
    if (targetId) await session.send("Target.closeTarget", { targetId }).catch(() => undefined)
    throw error
  } finally {
    await session.detach().catch(() => undefined)
  }
}

export async function findComposer(page: Page, signal?: AbortSignal): Promise<Locator> {
  const deadline = Date.now() + CHATGPT_OPERATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    for (const selector of COMPOSER_SELECTORS) {
      const locator = page.locator(selector).first()
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) return locator
    }
    await delay(200, signal)
  }
  throw new ChatGptSubagentError("CHATGPT_UI_CHANGED", `Could not find the ChatGPT composer within ${CHATGPT_OPERATION_TIMEOUT_MS} ms.`)
}

export async function forkLatestConversationTurn(page: Page, signal?: AbortSignal): Promise<Page> {
  throwIfAborted(signal)
  const sourceUrl = page.url()
  const context = page.context()
  const latestForkableTurn = page.locator(LATEST_FORKABLE_TURN_SELECTOR).last()
  await waitForVisibleLocator(latestForkableTurn, CHATGPT_OPERATION_TIMEOUT_MS, signal, "latest forkable assistant turn")
  await latestForkableTurn.scrollIntoViewIfNeeded()
  await latestForkableTurn.hover()

  const moreActions = latestForkableTurn.locator('button[aria-label="More actions"]').last()
  await waitForVisibleLocator(moreActions, CHATGPT_OPERATION_TIMEOUT_MS, signal, 'latest forkable assistant turn "More actions" button')
  await retryAfterDismissingBlockingOverlay(page, () => moreActions.click(), signal)

  const openNewBranch = page.getByRole("menuitem", { name: "Open new branch", exact: true }).last()
  await waitForVisibleLocator(openNewBranch, CHATGPT_OPERATION_TIMEOUT_MS, signal, '"Open new branch" menu item')
  await openNewBranch.focus()
  await openNewBranch.press("ArrowRight")

  const branchInNewChat = page.getByRole("menuitem", { name: "Branch in new Chat", exact: true }).last()
  await waitForVisibleLocator(branchInNewChat, CHATGPT_OPERATION_TIMEOUT_MS, signal, '"Branch in new Chat" menu item')
  const knownPages = new Set(context.pages())
  await branchInNewChat.click()

  const deadline = Date.now() + CHATGPT_OPERATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    const createdPage = context.pages().find((candidate) => !knownPages.has(candidate) && !candidate.isClosed())
    const branchPage = createdPage ?? (page.url() !== sourceUrl ? page : undefined)
    if (branchPage && isChatGptUrl(branchPage.url())) {
      await findComposerBefore(branchPage, deadline, signal)
      return branchPage
    }
    await delay(200, signal)
  }

  throw new ChatGptSubagentError("CHATGPT_UI_CHANGED", `ChatGPT did not open a new branch within ${CHATGPT_OPERATION_TIMEOUT_MS} ms.`)
}

export async function assertAuthenticated(page: Page): Promise<void> {
  const url = new URL(page.url())
  const loginRoute = /\/auth\/(login|signin)/i.test(url.pathname)
  const visibleLogin = await page
    .locator('a[href*="/auth/login"], a[href*="/auth/signin"], button:has-text("Log in")')
    .first()
    .isVisible()
    .catch(() => false)
  if (loginRoute || visibleLogin) {
    throw new ChatGptSubagentError(
      "CHATGPT_NOT_AUTHENTICATED",
      "The attached Chrome instance is not authenticated to ChatGPT. Sign in in that Chrome profile before using subagents."
    )
  }
}

export async function navigateAndCaptureConversationPayload(page: Page, conversationUrl: string): Promise<unknown | undefined> {
  const conversationId = extractConversationId(conversationUrl)
  if (!conversationId) return undefined
  const responsePromise = page
    .waitForResponse((response) => isConversationPayloadUrl(response.url(), conversationId) && response.status() === 200, {
      timeout: 10_000,
    })
    .then((response) => response.json())
    .catch(() => undefined)

  await navigateChatGptPage(page, conversationUrl)
  return responsePromise
}

export async function navigateChatGptPage(page: Page, url: string, signal?: AbortSignal): Promise<void> {
  await waitForPromise(page.goto(url, { waitUntil: "domcontentloaded", timeout: CHATGPT_OPERATION_TIMEOUT_MS }), signal)
}

export async function enterPrompt(page: Page, composer: Locator, prompt: string, signal?: AbortSignal): Promise<void> {
  await retryAfterDismissingBlockingOverlay(page, () => composer.click(), signal)
  await composer.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
  await composer.press("Backspace")
  await page.keyboard.insertText(prompt)
}

export async function submitComposer(page: Page, composer: Locator, signal?: AbortSignal): Promise<void> {
  const selectors = ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send" i]']
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    for (const selector of selectors) {
      const button = page.locator(selector).first()
      if ((await button.count()) > 0 && (await button.isVisible().catch(() => false)) && (await button.isEnabled().catch(() => false))) {
        await retryAfterDismissingBlockingOverlay(page, () => button.click(), signal)
        return
      }
    }
    await delay(50, signal)
  }
  await retryAfterDismissingBlockingOverlay(page, () => composer.press("Enter"), signal)
}

export async function dismissBlockingChatGptOverlay(page: Page, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal)
  const overlay = page.locator('#modal-beacon, [data-testid="modal-beacon"]').first()
  if ((await overlay.count()) === 0 || !(await overlay.isVisible().catch(() => false))) return false
  await page.keyboard.press("Escape")
  await delay(250, signal)
  return true
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw new ChatGptSubagentError(
    "REQUEST_ABORTED",
    "The ChatGPT subagent request was cancelled. A turn that was already submitted will not be retried automatically."
  )
}

export async function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ChatGptSubagentError("REQUEST_ABORTED", "The ChatGPT subagent request was cancelled."))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ChatGptSubagentError("REQUEST_ABORTED", "The ChatGPT subagent request was cancelled."))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

async function pageTargetId(context: BrowserContext, page: Page): Promise<string | undefined> {
  const session = await context.newCDPSession(page).catch(() => undefined)
  if (!session) return undefined
  try {
    const info = await session.send("Target.getTargetInfo")
    return info.targetInfo.targetId
  } catch {
    return undefined
  } finally {
    await session.detach().catch(() => undefined)
  }
}

async function retryAfterDismissingBlockingOverlay<T>(page: Page, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (!(await dismissBlockingChatGptOverlay(page, signal))) throw error
    return action()
  }
}

async function waitForVisibleLocator(locator: Locator, timeoutMs: number, signal: AbortSignal | undefined, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) return
    await delay(100, signal)
  }
  throw new ChatGptSubagentError("CHATGPT_UI_CHANGED", `Could not find ${description} within ${timeoutMs} ms.`)
}

async function findComposerBefore(page: Page, deadline: number, signal?: AbortSignal): Promise<Locator> {
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    for (const selector of COMPOSER_SELECTORS) {
      const locator = page.locator(selector).first()
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) return locator
    }
    await delay(200, signal)
  }
  throw new ChatGptSubagentError("CHATGPT_UI_CHANGED", "Could not find the ChatGPT composer before the branch operation timed out.")
}

export function isChatGptUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "chatgpt.com"
  } catch {
    return false
  }
}

function isConversationPayloadUrl(value: string, conversationId: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname === "chatgpt.com" && url.pathname === `/backend-api/conversations/${conversationId}`
  } catch {
    return false
  }
}

export function extractConversationId(value: string): string | undefined {
  try {
    const match = new URL(value).pathname.match(/(?:^|\/)c\/([^/?#]+)/)
    const rawConversationId = match?.[1]
    if (!rawConversationId) return undefined
    const conversationId = decodeURIComponent(rawConversationId)
    return conversationId.toLowerCase().startsWith("web:") ? undefined : conversationId
  } catch {
    return undefined
  }
}
