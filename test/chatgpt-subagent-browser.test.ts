import assert from "node:assert/strict"
import test from "node:test"

import {
  ChatGptTurnTracker,
  findLatestAssistantAfterPrompt,
} from "../src/tools/subagent/chatgpt-subagent-protocol.js"

function turnFrame(topicId: string, encodedItem: string): string {
  return JSON.stringify([
    {
      type: "message",
      topic_id: topicId,
      payload: {
        type: "conversation-turn-stream",
        payload: { type: "stream-item", encoded_item: encodedItem },
      },
    },
  ])
}

function message(
  role: "user" | "assistant",
  text: string,
  options: {
    conversationId?: string
    recipient?: string
    status?: string
    endTurn?: boolean | null
  } = {}
): string {
  return `event: delta\ndata: ${JSON.stringify({ conversation_id: options.conversationId, v: { message: { id: `${role}-1`, author: { role }, content: { content_type: "text", parts: [text] }, status: options.status ?? "finished_successfully", end_turn: options.endTurn ?? null, metadata: {}, recipient: options.recipient ?? "all" } } })}\n\n`
}

test("history recovery rejects an older identical prompt before the current turn appears", () => {
  const staleHistory = [
    { role: "user" as const, text: "repeat" },
    { role: "assistant" as const, text: "old answer" },
  ]

  assert.equal(findLatestAssistantAfterPrompt(staleHistory, "repeat", 2), undefined)
  assert.deepEqual(
    findLatestAssistantAfterPrompt(
      [
        ...staleHistory,
        { role: "user", text: "repeat" },
        { role: "assistant", text: "new answer" },
      ],
      "repeat",
      2
    ),
    {
      role: "assistant",
      text: "new answer",
    }
  )
})

test("CDP tracker binds only the submitted prompt and reconstructs exact final Markdown", () => {
  const activities: string[] = []
  const conversationIds: string[] = []
  const tracker = new ChatGptTurnTracker(
    "review",
    (activity) => {
      if (activity) activities.push(activity)
    },
    (conversationId) => conversationIds.push(conversationId)
  )
  const topic = "conversation-turn-turn-1"

  tracker.ingestFrame(
    turnFrame(
      "conversation-turn-other",
      message("user", "other", { conversationId: "wrong-conversation" })
    )
  )
  tracker.ingestFrame(
    turnFrame(topic, message("user", "review", { conversationId: "conversation-1" }))
  )
  tracker.ingestFrame(
    turnFrame(
      topic,
      message("assistant", "searching", {
        recipient: "web.run",
        status: "in_progress",
        endTurn: false,
      })
    )
  )
  tracker.ingestFrame(
    turnFrame(topic, message("assistant", "", { status: "in_progress", endTurn: null }))
  )
  tracker.ingestFrame(
    turnFrame(
      topic,
      'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"## Findings\\n\\n"}\n\n'
    )
  )
  tracker.ingestFrame(turnFrame(topic, 'event: delta\ndata: {"v":"- exact server response"}\n\n'))
  tracker.ingestFrame(
    turnFrame(
      topic,
      'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}\n\n'
    )
  )
  const result = tracker.ingestFrame(
    turnFrame(
      topic,
      'data: {"type":"message_stream_complete","conversation_id":"conversation-1"}\n\n'
    )
  )

  assert.deepEqual(result, {
    text: "## Findings\n\n- exact server response",
    conversationId: "conversation-1",
    turnId: "turn-1",
  })
  assert.deepEqual(conversationIds, ["conversation-1"])
  assert.ok(activities.includes("Searching the web"))
  assert.ok(activities.includes("Generating response"))
  assert.equal(activities.filter((activity) => activity === "Working").length, 1)
})

test("HTTP SSE tracker reconstructs the same final assistant response", () => {
  const tracker = new ChatGptTurnTracker("review")
  const sse = [
    message("user", "review"),
    message("assistant", "", { status: "in_progress", endTurn: null }),
    'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"HTTP exact"}\n\n',
    'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}\n\n',
    'data: {"type":"message_stream_complete","conversation_id":"conversation-http"}\n\n',
  ].join("")
  assert.deepEqual(tracker.ingestSse(sse), {
    text: "HTTP exact",
    conversationId: "conversation-http",
    turnId: undefined,
  })
})

test("HTTP SSE tracker counts bound heartbeats and safety review updates as activity without changing the status label", () => {
  const activities: Array<string | undefined> = []
  const tracker = new ChatGptTurnTracker("review", (activity) => activities.push(activity))

  tracker.ingestSse(": ping - before-bind\r\n\r\n")
  assert.deepEqual(activities, [])

  tracker.ingestSse(message("user", "review"))
  const labeledActivities = activities.filter((activity) => activity !== undefined)
  const activityCount = activities.length

  tracker.ingestSse(": ping - 2026-09-04 04:04:39.098910+00:00\r\n\r\n")
  tracker.ingestSse(
    `data: ${JSON.stringify({
      type: "safety_review_update",
      conversation_id: "conversation-http",
      active: true,
      protection_type: "cyber",
      message: "Our systems are thinking a bit more about this request before responding.",
    })}\n\n`
  )

  assert.equal(activities.length, activityCount + 2)
  assert.deepEqual(
    activities.filter((activity) => activity !== undefined),
    labeledActivities
  )
})

test("CDP tracker counts bound turn stream traffic as activity even when it has no status label", () => {
  const activities: Array<string | undefined> = []
  const tracker = new ChatGptTurnTracker("review", (activity) => activities.push(activity))
  const topic = "conversation-turn-turn-progress"

  tracker.ingestFrame(turnFrame(topic, message("user", "review")))
  const activityCount = activities.length
  tracker.ingestFrame(turnFrame(topic, ": ping - transport-only\n\n"))

  assert.equal(activities.length, activityCount + 1)
  assert.equal(activities.at(-1), undefined)
})

test("CDP tracker tolerates ChatGPT prompt whitespace normalization", () => {
  const tracker = new ChatGptTurnTracker("Optimize familiarity. \n\nGive your preferred syntax.")
  const topic = "conversation-turn-turn-normalized"

  tracker.ingestFrame(
    turnFrame(topic, message("user", "Optimize familiarity.\u00a0\n Give your preferred syntax."))
  )
  tracker.ingestFrame(turnFrame(topic, message("assistant", "done", { endTurn: true })))
  const result = tracker.ingestFrame(
    turnFrame(
      topic,
      'data: {"type":"message_stream_complete","conversation_id":"conversation-normalized"}\n\n'
    )
  )

  assert.deepEqual(result, {
    text: "done",
    conversationId: "conversation-normalized",
    turnId: "turn-normalized",
  })
})

test("CDP tracker does not complete a tool-call assistant message", () => {
  const tracker = new ChatGptTurnTracker("review")
  const topic = "conversation-turn-turn-2"
  tracker.ingestFrame(turnFrame(topic, message("user", "review")))
  tracker.ingestFrame(
    turnFrame(topic, message("assistant", "fast|query", { recipient: "web.run", endTurn: false }))
  )
  assert.equal(
    tracker.ingestFrame(
      turnFrame(
        topic,
        'data: {"type":"message_stream_complete","conversation_id":"conversation-2"}\n\n'
      )
    ),
    undefined
  )
})
