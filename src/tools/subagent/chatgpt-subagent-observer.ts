import type { CDPSession, Page } from "playwright-core"

import type { ChatGptSubagentActivity } from "./chatgpt-subagent-contracts.js"
import { ChatGptTurnTracker, type ChatGptTurnCompletion } from "./chatgpt-subagent-protocol.js"

export interface AssistantResponseObservation {
  response: Promise<ChatGptTurnCompletion>
  dispose(): Promise<void>
}

/** Observe one submitted turn from raw CDP HTTP SSE or the turn WebSocket; first exact completion wins. */
export async function observeAssistantResponse(
  page: Page,
  input: {
    prompt: string
    onActivity?: (activity: ChatGptSubagentActivity) => void
    onConversationId?: (conversationId: string) => void
  }
): Promise<AssistantResponseObservation> {
  const webSocketTracker = new ChatGptTurnTracker(input.prompt, input.onActivity, input.onConversationId)
  const httpTracker = new ChatGptTurnTracker(input.prompt, input.onActivity, input.onConversationId)
  const requestIds = new Set<string>()
  const buffers = new Map<string, string>()
  let cdp: CDPSession | undefined
  let settled = false
  let resolveResponse!: (response: ChatGptTurnCompletion) => void
  let rejectResponse!: (error: unknown) => void
  const response = new Promise<ChatGptTurnCompletion>((resolve, reject) => {
    resolveResponse = resolve
    rejectResponse = reject
  })

  const cleanup = async (): Promise<void> => {
    page.off("close", pageCloseHandler)
    await cdp?.detach().catch(() => undefined)
    cdp = undefined
  }

  const finish = (result?: ChatGptTurnCompletion): void => {
    if (!result || settled) return
    settled = true
    resolveResponse(result)
    void cleanup()
  }

  const feedHttp = (requestId: string, text: string): void => {
    if (settled || !text) return
    let buffer = (buffers.get(requestId) ?? "") + text
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer)
      if (!match || match.index === undefined) break
      const end = match.index + match[0].length
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end)
      finish(httpTracker.ingestSse(block))
      if (settled) return
    }
    buffers.set(requestId, buffer)
  }

  const frameHandler = (event: { response?: { payloadData?: string } }): void => {
    const payload = event.response?.payloadData
    if (!payload || settled) return
    try {
      finish(webSocketTracker.ingestFrame(payload))
    } catch {
      // Ignore unrelated or malformed private-protocol frames.
    }
  }

  const requestHandler = (event: { requestId: string; request?: { url?: string; method?: string } }): void => {
    if (settled || event.request?.method !== "POST" || !isConversationEndpoint(event.request.url)) return
    requestIds.add(event.requestId)
    buffers.set(event.requestId, "")
  }

  const responseHandler = (event: { requestId: string }): void => {
    if (settled || !requestIds.has(event.requestId) || !cdp) return
    void cdp
      .send("Network.streamResourceContent", { requestId: event.requestId })
      .then((result) => {
        const bufferedData = typeof result.bufferedData === "string" ? result.bufferedData : ""
        if (bufferedData) feedHttp(event.requestId, Buffer.from(bufferedData, "base64").toString("utf8"))
      })
      .catch(() => undefined)
  }

  const dataHandler = (event: { requestId: string; data?: string }): void => {
    if (settled || !requestIds.has(event.requestId) || !event.data) return
    feedHttp(event.requestId, Buffer.from(event.data, "base64").toString("utf8"))
  }

  const loadingFinishedHandler = (event: { requestId: string }): void => {
    if (settled || !requestIds.has(event.requestId) || !cdp) return
    void cdp
      .send("Network.getResponseBody", { requestId: event.requestId })
      .then((result) => {
        if (settled || typeof result.body !== "string") return
        const body = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body
        const fallback = new ChatGptTurnTracker(input.prompt, input.onActivity, input.onConversationId)
        finish(fallback.ingestSse(body))
      })
      .catch(() => undefined)
  }

  const pageCloseHandler = (): void => {
    if (settled) return
    settled = true
    rejectResponse(new Error("ChatGPT managed page closed while a subagent turn was running."))
    void cleanup()
  }

  try {
    cdp = await page.context().newCDPSession(page)
    await cdp.send("Network.enable")
    cdp.on("Network.webSocketFrameReceived", frameHandler)
    cdp.on("Network.requestWillBeSent", requestHandler)
    cdp.on("Network.responseReceived", responseHandler)
    cdp.on("Network.dataReceived", dataHandler)
    cdp.on("Network.loadingFinished", loadingFinishedHandler)
    page.on("close", pageCloseHandler)
  } catch (error) {
    await cleanup()
    throw error
  }

  return {
    response,
    async dispose() {
      if (!settled) {
        settled = true
        rejectResponse(new Error("ChatGPT subagent response observation was disposed."))
      }
      await cleanup()
    },
  }
}

function isConversationEndpoint(value?: string): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.hostname === "chatgpt.com" && url.pathname === "/backend-api/f/conversation"
  } catch {
    return false
  }
}
