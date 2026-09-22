import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core"

import { MCP_CONFIG } from "../src/config.js"
import { createChatGptSubagentService } from "../src/tools/subagent/chatgpt-subagent.js"
import { ChatGptSubagentError } from "../src/tools/subagent/chatgpt-subagent-contracts.js"

for (const memory of [false, true]) {
  test(`idle cleanup ${memory ? "allows saved agents to resume" : "reports temporary agents as expired and retains their results"}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "shellby-agent-lifecycle-"))
    const previousStateDir = MCP_CONFIG.stateDir
    MCP_CONFIG.stateDir = directory
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 })
    const fixture = browserFixture()
    const connect = t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
    const service = createChatGptSubagentService()
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
        error instanceof ChatGptSubagentError && error.code === "AGENT_TARGET_LOST"
    )
  })
}

function browserFixture(): { browser: Browser; pages: Page[]; readonly submissions: number } {
  const pages: Page[] = []
  const sessions = new Map<
    Page,
    EventEmitter & { send(method: string): Promise<unknown>; detach(): Promise<void> }
  >()
  let connected = true
  let submissions = 0
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
