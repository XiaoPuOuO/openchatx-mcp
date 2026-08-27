import assert from "node:assert/strict"
import test from "node:test"

import { MCP_CONFIG } from "../src/config.js"
import { ChatGptSubagentError, type ChatGptSubagentOptions } from "../src/tools/subagent/chatgpt-subagent-contracts.js"
import {
  askSubagent,
  appendFirstTurnMode,
  beginAgentOperation,
  cleanupIdleAgents,
  clearExpiredRateLimit,
  createAgent,
  createChatGptSubagentRuntimeState,
  conversationUrlForStart,
  createChatGptSubagentService,
  disposeSubagents,
  endAgentOperation,
  ensureAgentPage,
  pollSubagent,
  type BrowserAgentState,
  type BrowserTurnState,
  type ChatGptSubagentRuntimeState,
} from "../src/tools/subagent/chatgpt-subagent.js"

function createRuntime(options: ChatGptSubagentOptions = {}): ChatGptSubagentRuntimeState {
  return createChatGptSubagentRuntimeState({
    cdpEndpoint: "http://127.0.0.1:1",
    interactionDelayMs: 0,
    minInterTurnDelayMs: 0,
    persistAgents: false,
    ...options,
  })
}

function installBackgroundPage(runtime: ChatGptSubagentRuntimeState, page: object): void {
  const existingPage = { isClosed: () => false }
  const pages: object[] = [existingPage]
  runtime.context = {
    pages: () => pages,
    newCDPSession: async (candidate: object) => ({
      send: async (method: string) => (method === "Target.getTargetInfo" ? { targetInfo: { targetId: candidate === page ? "target-1" : "other" } } : {}),
      on: () => undefined,
      detach: async () => undefined,
    }),
  } as never
  runtime.browser = {
    isConnected: () => true,
    newBrowserCDPSession: async () => ({
      send: async (method: string) => {
        if (method === "Target.createTarget") {
          pages.push(page)
          return { targetId: "target-1" }
        }
        return { success: true }
      },
      detach: async () => undefined,
    }),
  } as never
}

function createRunningTurn(agentId: string, lastActivityAt: number, recoveryAttempted = false): BrowserTurnState {
  let settle: () => void = () => undefined
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  return {
    turnId: `${agentId}_turn_1`,
    agentId,
    status: "running",
    recoveryAttempted,
    lastActivityAt,
    prompt: "submitted prompt",
    settled,
    settle,
  }
}

test("new agents start from configured project URL", async () => {
  const runtime = createRuntime({ chatGptUrl: "https://chatgpt.com/g/g-p-example/project" })
  let currentUrl = "about:blank"
  const navigations: string[] = []
  const page = {
    isClosed: () => false,
    url: () => currentUrl,
    setViewportSize: async () => undefined,
    goto: async (url: string) => {
      currentUrl = url
      navigations.push(url)
    },
    close: async () => undefined,
    locator: (selector: string) => ({
      first: () => ({ count: async () => (selector === "#prompt-textarea" ? 1 : 0), isVisible: async () => selector === "#prompt-textarea" }),
    }),
  }
  installBackgroundPage(runtime, page)
  const agent = await createAgent(runtime, "project-agent")
  assert.equal(agent.page, page)
  assert.deepEqual(navigations, ["https://chatgpt.com/g/g-p-example/project"])
})

test("memoryless agents start in temporary chat without retaining a conversation URL", async () => {
  const runtime = createRuntime({ chatGptUrl: "https://chatgpt.com/g/g-p-example/project" })
  let currentUrl = "about:blank"
  const navigations: string[] = []
  const page = {
    isClosed: () => false,
    url: () => currentUrl,
    setViewportSize: async () => undefined,
    goto: async (url: string) => {
      currentUrl = url
      navigations.push(url)
    },
    close: async () => undefined,
    locator: (selector: string) => ({
      first: () => ({ count: async () => (selector === "#prompt-textarea" ? 1 : 0), isVisible: async () => selector === "#prompt-textarea" }),
    }),
  }
  installBackgroundPage(runtime, page)

  const agent = await createAgent(runtime, "memoryless-agent", undefined, false)

  assert.equal(agent.page, page)
  assert.equal(agent.conversationUrl, undefined)
  assert.deepEqual(navigations, ["https://chatgpt.com/?temporary-chat=true"])
})

test("same agent keeps one page across multiple turns and captures conversation id from CDP", async () => {
  const runtime = createRuntime({ chatGptUrl: "https://chatgpt.com/g/g-p-example/project" })
  let currentUrl = "https://chatgpt.com/g/g-p-example/project"
  let inserted = ""
  let frameHandler: ((event: { response?: { payloadData?: string } }) => void) | undefined
  let closeHandler: (() => void) | undefined
  let detachCount = 0
  let sendCount = 0
  const emitTurn = (answer: string, conversationId: string) => {
    const topic = `conversation-turn-server-${sendCount}`
    const wrap = (encoded: string) =>
      JSON.stringify([{ topic_id: topic, payload: { type: "conversation-turn-stream", payload: { type: "stream-item", encoded_item: encoded } } }])
    const msg = (role: string, text: string, endTurn: boolean | null, id?: string) =>
      `data: ${JSON.stringify({ conversation_id: id, v: { message: { id: `${role}-${sendCount}`, author: { role }, content: { parts: [text] }, status: "finished_successfully", end_turn: endTurn, recipient: "all", metadata: {} } } })}\n\n`
    frameHandler?.({ response: { payloadData: wrap(msg("user", inserted, null, conversationId)) } })
    if (sendCount === 1) assert.equal(runtime.agents.get("multi")?.conversationUrl, `https://chatgpt.com/g/g-p-example/c/${conversationId}`)
    if (sendCount === 1) {
      frameHandler?.({
        response: {
          payloadData: wrap(
            `data: ${JSON.stringify({ v: { message: { id: "tool-1", author: { role: "assistant" }, content: { parts: [JSON.stringify({ path: "/Shellby MCP/link-test/shell_list", args: {} })] }, status: "finished_successfully", end_turn: false, recipient: "api_tool.call_tool", metadata: {} } } })}\n\n`
          ),
        },
      })
    }
    currentUrl = `https://chatgpt.com/c/${conversationId}`
    frameHandler?.({ response: { payloadData: wrap(msg("assistant", answer, true)) } })
    frameHandler?.({ response: { payloadData: wrap(`data: ${JSON.stringify({ type: "message_stream_complete", conversation_id: conversationId })}\n\n`) } })
  }
  const composer = { count: async () => 1, isVisible: async () => true, click: async () => undefined, press: async () => undefined }
  const hidden = { count: async () => 0, isVisible: async () => false, isEnabled: async () => false }
  const page = {
    isClosed: () => false,
    url: () => currentUrl,
    context: () => ({
      newCDPSession: async () => ({
        send: async () => undefined,
        on: (name: string, fn: typeof frameHandler) => {
          if (name === "Network.webSocketFrameReceived") frameHandler = fn
        },
        detach: async () => {
          detachCount += 1
        },
      }),
    }),
    on: (name: string, fn: () => void) => {
      if (name === "close") closeHandler = fn
      return page
    },
    off: () => page,
    locator: (selector: string) => ({
      first: () =>
        selector === "#prompt-textarea"
          ? composer
          : selector.includes("send-button")
            ? {
                count: async () => 1,
                isVisible: async () => true,
                isEnabled: async () => true,
                click: async () => {
                  sendCount += 1
                  emitTurn(`answer-${sendCount}`, "conversation-1")
                },
              }
            : hidden,
    }),
    keyboard: {
      insertText: async (text: string) => {
        inserted = text
      },
      press: async () => undefined,
    },
    close: async () => closeHandler?.(),
  }
  const agent: BrowserAgentState = { agentId: "multi", status: "idle", page: page as never, lastUsedAt: Date.now(), turnCount: 0 }
  runtime.browser = { isConnected: () => true, close: async () => undefined } as never
  runtime.context = { pages: () => [page] } as never
  runtime.agents.set(agent.agentId, agent)

  const first = await askSubagent(runtime, { agentId: "multi", prompt: "first", oververbosity: 2, notificationSessionId: "session-1" })
  const firstResult = await pollSubagent(runtime, first.turnId, 100)
  assert.equal(firstResult.response, "answer-1")
  assert.equal(agent.status, "idle")
  assert.equal(agent.conversationUrl, "https://chatgpt.com/c/conversation-1")
  assert.deepEqual(runtime.pendingEvents.get("session-1"), ["agent_finished:multi:multi_turn_1"])
  assert.equal(runtime.pendingEvents.has(""), false)
  assert.match(inserted, /Respond terse like smart caveman/)

  const second = await askSubagent(runtime, { agentId: "multi", prompt: "second", oververbosity: 5, notificationSessionId: "session-1" })
  const secondResult = await pollSubagent(runtime, second.turnId, 100)
  assert.equal(secondResult.response, "answer-2")
  assert.equal(inserted, "second")
  assert.equal(agent.page, page)
  assert.equal(agent.turnCount, 2)
  assert.equal(detachCount, 2)
  await disposeSubagents(runtime)
})

test("first-turn oververbosity injection exactly matches the previous prompt contract", () => {
  const injected =
    "Respond terse like smart caveman — drop articles, filler, pleasantries. Fragments OK. Technical terms exact. Code unchanged. Pattern: [thing] [action] [reason]. [next step].\n\nNot use `subagent` or `computer_*` tools."
  assert.equal(appendFirstTurnMode("prompt", 1), `prompt\n\n---\n\nSwitch to caveman ultra mode. ${injected}`)
  assert.equal(appendFirstTurnMode("prompt", 2), `prompt\n\n---\n\nSwitch to caveman full mode. ${injected}`)
  assert.equal(appendFirstTurnMode("prompt", 3), `prompt\n\n---\n\nSwitch to caveman lite mode. ${injected}`)
  assert.equal(appendFirstTurnMode("prompt", 4), `prompt\n\n---\n\nSwitch to caveman lite mode. ${injected} Favor completeness over terseness when useful.`)
  assert.equal(appendFirstTurnMode(" prompt ", 5), " prompt ")
})

test("wrong conversation URL is restored on the same managed page before submission", async () => {
  const runtime = createRuntime()
  let currentUrl = "https://chatgpt.com/c/wrong"
  const navigations: string[] = []
  const composer = { count: async () => 1, isVisible: async () => true }
  const hidden = { count: async () => 0, isVisible: async () => false }
  const page = {
    isClosed: () => false,
    url: () => currentUrl,
    goto: async (url: string) => {
      currentUrl = url
      navigations.push(url)
    },
    locator: (selector: string) => ({ first: () => (selector === "#prompt-textarea" ? composer : hidden) }),
  }
  const agent: BrowserAgentState = {
    agentId: "restore-same-page",
    status: "idle",
    page: page as never,
    conversationUrl: "https://chatgpt.com/c/correct",
    lastUsedAt: Date.now(),
    turnCount: 1,
  }

  assert.equal(await ensureAgentPage(runtime, agent), page)
  assert.deepEqual(navigations, ["https://chatgpt.com/c/correct"])
})

test("idle cleanup closes only the page and a later turn restores the saved conversation", async () => {
  const runtime = createRuntime()
  let oldClosed = false
  const oldPage = {
    isClosed: () => oldClosed,
    url: () => "https://chatgpt.com/c/saved",
    close: async () => {
      oldClosed = true
    },
  }
  const agent: BrowserAgentState = {
    agentId: "idle",
    status: "idle",
    page: oldPage as never,
    conversationUrl: "https://chatgpt.com/c/saved",
    lastUsedAt: 1,
    turnCount: 2,
  }
  runtime.agents.set(agent.agentId, agent)

  await cleanupIdleAgents(runtime, 30 * 60_000 + 2)
  assert.equal(oldClosed, true)
  assert.equal(runtime.agents.get(agent.agentId), agent)
  assert.equal(agent.page, undefined)
  assert.equal(agent.conversationUrl, "https://chatgpt.com/c/saved")
  assert.equal(agent.turnCount, 2)

  let currentUrl = "about:blank"
  const navigations: string[] = []
  const composer = { count: async () => 1, isVisible: async () => true }
  const hidden = { count: async () => 0, isVisible: async () => false }
  const replacement = {
    isClosed: () => false,
    url: () => currentUrl,
    setViewportSize: async () => undefined,
    goto: async (url: string) => {
      currentUrl = url
      navigations.push(url)
    },
    locator: (selector: string) => ({ first: () => (selector === "#prompt-textarea" ? composer : hidden) }),
    close: async () => undefined,
  }
  installBackgroundPage(runtime, replacement)

  assert.equal(await ensureAgentPage(runtime, agent), replacement)
  assert.deepEqual(navigations, ["https://chatgpt.com/c/saved"])
  assert.equal(agent.turnCount, 2)
})

test("30 minutes without progress fails an unbound turn and releases capacity", async () => {
  const runtime = createRuntime()
  const now = 30 * 60_000 + 10
  const page = { isClosed: () => false, url: () => "https://chatgpt.com/" }
  const agent: BrowserAgentState = { agentId: "stalled", status: "Generating response", page: page as never, lastUsedAt: 1, turnCount: 1 }
  const turn = createRunningTurn(agent.agentId, 1)
  runtime.agents.set(agent.agentId, agent)
  runtime.turns.set(turn.turnId, turn)
  runtime.activeOperations.set(agent.agentId, turn.turnId)

  await cleanupIdleAgents(runtime, now)
  assert.equal(turn.status, "failed")
  assert.equal(turn.errorCode, "AGENT_IDLE_EXPIRED")
  assert.equal(agent.status, "uncertain")
  assert.equal(runtime.activeOperations.has(agent.agentId), false)
})

test("30-minute cutoff performs one recovery and settles from saved conversation history", async () => {
  const runtime = createRuntime({ timeoutMs: 100 })
  let oldClosed = false
  const oldPage = {
    isClosed: () => oldClosed,
    url: () => "https://chatgpt.com/c/recovery",
    close: async () => {
      oldClosed = true
    },
  }
  const agent: BrowserAgentState = {
    agentId: "recover",
    status: "Generating response",
    page: oldPage as never,
    conversationUrl: "https://chatgpt.com/c/recovery",
    lastUsedAt: 1,
    turnCount: 1,
  }
  const turn = createRunningTurn(agent.agentId, 1)
  const payload = {
    messages: [
      { author: { role: "user" }, content: { parts: [turn.prompt] } },
      { author: { role: "assistant" }, content: { parts: ["recovered answer"] }, end_turn: true, recipient: "all" },
    ],
  }
  let currentUrl = "about:blank"
  const closeHandlers = new Set<() => void>()
  const composer = { count: async () => 1, isVisible: async () => true }
  const hidden = { count: async () => 0, isVisible: async () => false }
  const recoveryPage = {
    isClosed: () => false,
    url: () => currentUrl,
    setViewportSize: async () => undefined,
    goto: async (url: string) => {
      currentUrl = url
    },
    waitForResponse: async (predicate: (response: object) => boolean) => {
      const response = {
        url: () => "https://chatgpt.com/backend-api/conversations/recovery",
        status: () => 200,
        json: async () => payload,
      }
      assert.equal(predicate(response), true)
      return response
    },
    context: () => runtime.context,
    on: (name: string, handler: () => void) => {
      if (name === "close") closeHandlers.add(handler)
      return recoveryPage
    },
    off: (_name: string, handler: () => void) => {
      closeHandlers.delete(handler)
      return recoveryPage
    },
    locator: (selector: string) => ({ first: () => (selector === "#prompt-textarea" ? composer : hidden) }),
    close: async () => undefined,
  }
  installBackgroundPage(runtime, recoveryPage)
  runtime.agents.set(agent.agentId, agent)
  runtime.turns.set(turn.turnId, turn)
  runtime.activeOperations.set(agent.agentId, turn.turnId)

  await cleanupIdleAgents(runtime, 30 * 60_000 + 10)
  assert.equal(turn.recoveryAttempted, true)
  assert.equal(turn.status, "completed")
  assert.equal(turn.response, "recovered answer")
  assert.equal(agent.status, "idle")
  assert.equal(agent.page, recoveryPage)
  assert.equal(agent.turnCount, 1)
  assert.equal(oldClosed, true)
  assert.equal(runtime.activeOperations.has(agent.agentId), false)
})

test("one-shot recovery fails immediately when history has no final answer", async () => {
  const runtime = createRuntime({ timeoutMs: 100 })
  const oldPage = { isClosed: () => false, url: () => "https://chatgpt.com/c/missing", close: async () => undefined }
  const agent: BrowserAgentState = {
    agentId: "recover-missing",
    status: "Generating response",
    page: oldPage as never,
    conversationUrl: "https://chatgpt.com/c/missing",
    lastUsedAt: 1,
    turnCount: 1,
  }
  const turn = createRunningTurn(agent.agentId, 1)
  let currentUrl = "about:blank"
  const composer = { count: async () => 1, isVisible: async () => true }
  const hidden = { count: async () => 0, isVisible: async () => false }
  const recoveryPage = {
    isClosed: () => false,
    url: () => currentUrl,
    setViewportSize: async () => undefined,
    goto: async (url: string) => {
      currentUrl = url
    },
    waitForResponse: async (predicate: (response: object) => boolean) => {
      const response = {
        url: () => "https://chatgpt.com/backend-api/conversations/missing",
        status: () => 200,
        json: async () => ({ messages: [{ author: { role: "user" }, content: { parts: [turn.prompt] } }] }),
      }
      assert.equal(predicate(response), true)
      return response
    },
    locator: (selector: string) => ({ first: () => (selector === "#prompt-textarea" ? composer : hidden) }),
    close: async () => undefined,
  }
  installBackgroundPage(runtime, recoveryPage)
  runtime.agents.set(agent.agentId, agent)
  runtime.turns.set(turn.turnId, turn)
  runtime.activeOperations.set(agent.agentId, turn.turnId)

  await cleanupIdleAgents(runtime, 30 * 60_000 + 10)
  assert.equal(turn.recoveryAttempted, true)
  assert.equal(turn.status, "failed")
  assert.equal(turn.errorCode, "AGENT_IDLE_EXPIRED")
  assert.match(turn.errorMessage ?? "", /expired after 30 minutes without observable progress/)
  assert.equal(agent.status, "uncertain")
  assert.equal(runtime.activeOperations.has(agent.agentId), false)
  assert.throws(
    () => beginAgentOperation(runtime, agent.agentId),
    (error: unknown) => error instanceof ChatGptSubagentError && error.code === "AGENT_BUSY" && /uncertain upstream state/.test(error.message)
  )
})

test("running poll activity comes from agent lifecycle state", async () => {
  const runtime = createRuntime()
  const agent: BrowserAgentState = { agentId: "progress", status: "Searching the web", lastUsedAt: Date.now(), turnCount: 1 }
  const turn = createRunningTurn(agent.agentId, Date.now())
  runtime.agents.set(agent.agentId, agent)
  runtime.turns.set(turn.turnId, turn)

  const result = await pollSubagent(runtime, turn.turnId, 0)
  assert.equal(result.status, "running")
  assert.equal(result.activity, "Searching the web")
})

test("conversation URL fallback preserves configured project scope", () => {
  assert.equal(conversationUrlForStart("https://chatgpt.com/g/g-p-example/project", "conversation-1"), "https://chatgpt.com/g/g-p-example/c/conversation-1")
  assert.equal(conversationUrlForStart("https://chatgpt.com/", "conversation-1"), "https://chatgpt.com/c/conversation-1")
})
test("configured pacing values are retained", () => {
  const runtime = createChatGptSubagentRuntimeState({ interactionDelayMs: 375, minInterTurnDelayMs: 2_000, persistAgents: false })
  assert.equal(runtime.interactionDelayMs, 375)
  assert.equal(runtime.minInterTurnDelayMs, 2_000)
})

test("hard caps concurrent generations at three", () => {
  const runtime = createRuntime({ maxConcurrentAgents: 99 })
  beginAgentOperation(runtime, "a")
  beginAgentOperation(runtime, "b")
  beginAgentOperation(runtime, "c")
  assert.throws(
    () => beginAgentOperation(runtime, "d"),
    (error: unknown) => error instanceof ChatGptSubagentError && error.code === "SUBAGENT_CAPACITY_REACHED"
  )
  endAgentOperation(runtime, "a")
  endAgentOperation(runtime, "b")
  endAgentOperation(runtime, "c")
})

test("rate limit modal starts cooldown and expired cooldown can be dismissed", async () => {
  const runtime = createRuntime()
  let visible = true
  const modal = {
    isVisible: async () => visible,
    getByRole: () => ({
      first: () => ({
        click: async () => {
          visible = false
        },
      }),
    }),
  }
  const page = {
    url: () => "https://chatgpt.com/",
    locator: () => ({ first: () => modal }),
    keyboard: {
      press: async () => {
        visible = false
      },
    },
  }
  runtime.context = { pages: () => [page] } as never
  runtime.browser = { isConnected: () => true } as never
  await assert.rejects(
    askSubagent(runtime, { agentId: "limited", prompt: "x", oververbosity: 2 }),
    (error: unknown) => error instanceof ChatGptSubagentError && error.code === "SUBAGENT_RATE_LIMITED"
  )
  assert.ok(runtime.rateLimitedUntil > Date.now())
  runtime.rateLimitedUntil = Date.now() - 1
  await clearExpiredRateLimit(runtime)
  assert.equal(runtime.rateLimitedUntil, 0)
  assert.equal(visible, false)
})

test("service reports unavailable CDP clearly", async () => {
  const service = createChatGptSubagentService({ cdpEndpoint: "http://127.0.0.1:1", connectTimeoutMs: 100, persistAgents: false })
  await assert.rejects(service.connect(), /already-running debuggable Chrome instance.*attach-only/i)
  await service.dispose()
})

test("tool descriptions and injected prompt defaults remain configured", () => {
  assert.equal(MCP_CONFIG.chatGpt.defaultOververbosity, 2)
})
