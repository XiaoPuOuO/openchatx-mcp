import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core"

import { MCP_CONFIG } from "../../../src/config.js"
import { createChatGptDelegationService } from "../../../src/tools/delegation/chatgpt-service.js"
import { ChatGptDelegationError } from "../../../src/tools/delegation/contracts.js"

for (const memory of [false, true]) {
  test(`idle cleanup ${memory ? "allows saved agents to resume" : "reports temporary agents as expired and retains their results"}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "shellby-agent-lifecycle-"))
    const previousStateDir = MCP_CONFIG.stateDir
    MCP_CONFIG.stateDir = directory
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 })
    const fixture = browserFixture()
    const connect = t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
    const service = createChatGptDelegationService()
    t.after(async () => {
      await service.dispose()
      MCP_CONFIG.stateDir = previousStateDir
      rmSync(directory, { recursive: true, force: true })
    })

    const request = { agentId: "researcher", prompt: "Review this", memory }
    const turnId = await service.ask(request, {})
    const completed = await service.poll(turnId, 0)
    assert.equal(completed.status, "completed")
    assert.equal(completed.response, "Reviewed")

    t.mock.timers.tick(29 * 60_000)
    await setImmediate()
    assert.equal(fixture.pages[0]?.isClosed(), false)
    t.mock.timers.tick(60_000)
    await setImmediate()
    assert.equal(fixture.pages[0]?.isClosed(), true)
    assert.deepEqual(await service.poll(turnId, 0), completed)

    if (memory) {
      const nextTurnId = await service.ask({ ...request, prompt: "Follow up" }, {})
      assert.equal((await service.poll(nextTurnId, 0)).status, "completed")
      assert.equal(fixture.pages.length, 2)
      const branchPage = fixture.pages[1]
      assert.ok(branchPage)
      assert.match(branchPage.url(), /\/c\/lifecycle-conversation$/u)
    } else {
      // Expiration stays specific even without Chrome, or if the caller changes memory.
      await fixture.browser.close()
      for (const requestedMemory of [false, true]) {
        await assert.rejects(
          service.ask({ ...request, prompt: "Follow up", memory: requestedMemory }, {}),
          {
            code: "TEMP_AGENT_EXPIRED",
            message:
              "Temporary agent researcher was closed after 30 minutes of inactivity. Its conversation cannot be resumed.",
          }
        )
      }
      assert.equal(connect.mock.callCount(), 1)
      assert.equal(fixture.pages.length, 1)
      assert.equal(fixture.submissions, 1)
      assert.deepEqual(await service.poll(turnId, 0), completed)
    }

    // An externally closed temporary page still gets the existing page-loss error.
    const other = { agentId: "closed-externally", prompt: "Review this", memory: false }
    await service.ask(other, {})
    await fixture.pages.at(-1)?.close()
    await assert.rejects(
      service.ask(other, {}),
      (error: unknown) =>
        error instanceof ChatGptDelegationError && error.code === "AGENT_TARGET_LOST"
    )
  })
}

test("persistence initialization failure blocks delegation before browser connection", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-agent-persistence-init-"))
  const blockedStateDir = join(directory, "state-file")
  writeFileSync(blockedStateDir, "blocked")
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = blockedStateDir
  const warn = t.mock.method(console, "warn", () => {})
  const connect = t.mock.method(chromium, "connectOverCDP", async () => browserFixture().browser)
  const service = createChatGptDelegationService()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })

  await assert.rejects(
    service.ask({ agentId: "researcher", prompt: "Review this", memory: true }, {}),
    (error: unknown) =>
      error instanceof ChatGptDelegationError &&
      error.code === "SUBAGENT_PERSISTENCE_UNAVAILABLE" &&
      /No new prompt was submitted/u.test(error.message)
  )
  assert.equal(connect.mock.callCount(), 0)
  assert.equal(warn.mock.callCount(), 1)
})

test("post-submit persistence failure keeps the turn valid and blocks later submission", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-agent-persistence-write-"))
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = directory
  const warn = t.mock.method(console, "warn", () => {})
  const fixture = browserFixture()
  t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
  const service = createChatGptDelegationService()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })

  const breaker = new DatabaseSync(join(directory, "subagents.sqlite"))
  breaker.exec(`
    CREATE TRIGGER fail_agents_write
    BEFORE INSERT ON agents
    BEGIN
      SELECT RAISE(ABORT, 'forced write failure');
    END;
  `)
  breaker.close()

  const turnId = await service.ask(
    { agentId: "researcher", prompt: "Review this", memory: true },
    {}
  )
  assert.equal(turnId, "researcher_turn_1")
  assert.equal((await service.poll(turnId, 0)).status, "completed")
  assert.equal(fixture.submissions, 1)
  assert.equal(warn.mock.callCount(), 1)

  await assert.rejects(
    service.ask({ agentId: "researcher", prompt: "Follow up", memory: true }, {}),
    (error: unknown) =>
      error instanceof ChatGptDelegationError && error.code === "SUBAGENT_PERSISTENCE_UNAVAILABLE"
  )
  assert.equal(fixture.submissions, 1)
})

test("failed idle page close does not expire a temporary agent", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-agent-idle-close-failure-"))
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = directory
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 })
  const fixture = browserFixture({ pageCloseFailures: 1 })
  t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
  const service = createChatGptDelegationService()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })

  const request = { agentId: "temporary", prompt: "Review this", memory: false }
  const turnId = await service.ask(request, {})
  assert.equal((await service.poll(turnId, 0)).status, "completed")

  t.mock.timers.tick(29 * 60_000)
  await setImmediate()
  t.mock.timers.tick(60_000)
  await setImmediate()
  assert.equal(fixture.pages[0]?.isClosed(), false)

  const followUpTurnId = await service.ask({ ...request, prompt: "Follow up" }, {})
  assert.equal((await service.poll(followUpTurnId, 0)).status, "completed")
  assert.equal(fixture.submissions, 2)
})

function browserFixture(options: { pageCloseFailures?: number } = {}): {
  browser: Browser
  pages: Page[]
  readonly submissions: number
} {
  const pages: Page[] = []
  const sessions = new Map<
    Page,
    EventEmitter & { send(method: string): Promise<unknown>; detach(): Promise<void> }
  >()
  let connected = true
  let submissions = 0
  let remainingPageCloseFailures = options.pageCloseFailures ?? 0
  const context = {
    pages: () => pages.filter((page) => !page.isClosed()),
    newCDPSession: async (page: Page) => sessions.get(page),
  }
  const browser = {
    isConnected: () => connected,
    contexts: () => [context],
    close: async () => {
      connected = false
    },
    newBrowserCDPSession: async () => ({
      detach: async () => {},
      send: async (method: string) => {
        assert.equal(method, "Target.createTarget")
        const targetId = `target-${pages.length}`
        let closed = false
        let url = "about:blank"
        let prompt = ""
        const cdp = Object.assign(new EventEmitter(), {
          send: async () => ({ targetInfo: { targetId } }),
          detach: async () => {},
        })
        const page = Object.assign(new EventEmitter(), {
          isClosed: () => closed,
          close: async () => {
            if (remainingPageCloseFailures > 0) {
              remainingPageCloseFailures -= 1
              throw new Error("forced page close failure")
            }
            closed = true
          },
          url: () => url,
          goto: async (value: string) => {
            url = value
          },
          context: () => context as unknown as BrowserContext,
          keyboard: {
            insertText: async (value: string) => {
              prompt = value
            },
          },
          locator: (selector: string) => {
            const visible =
              selector === "#prompt-textarea" || selector === 'button[data-testid="send-button"]'
            const locator = {
              first: () => locator,
              count: async () => Number(visible),
              isVisible: async () => visible,
              isEnabled: async () => true,
              press: async () => {},
              click: async () => {
                if (selector !== 'button[data-testid="send-button"]') return
                submissions += 1
                const body = [
                  { v: { message: { author: { role: "user" }, content: { parts: [prompt] } } } },
                  {
                    v: {
                      message: {
                        author: { role: "assistant" },
                        content: { parts: ["Reviewed"] },
                        status: "finished_successfully",
                        end_turn: true,
                      },
                    },
                  },
                  { type: "message_stream_complete", conversation_id: "lifecycle-conversation" },
                ]
                  .map((item) => `data: ${JSON.stringify(item)}\n\n`)
                  .join("")
                cdp.emit("Network.requestWillBeSent", {
                  requestId: "turn",
                  request: {
                    method: "POST",
                    url: "https://chatgpt.com/backend-api/f/conversation",
                  },
                })
                cdp.emit("Network.dataReceived", {
                  requestId: "turn",
                  data: Buffer.from(body).toString("base64"),
                })
              },
            }
            return locator
          },
        }) as unknown as Page
        pages.push(page)
        sessions.set(page, cdp)
        return { targetId }
      },
    }),
  } as unknown as Browser
  return {
    browser,
    pages,
    get submissions() {
      return submissions
    },
  }
}
