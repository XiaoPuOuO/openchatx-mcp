---
summary: "Subagent completion detection, event delivery, bounded recovery, result settlement, and failure semantics."
paths:
  - src/tools/subagent/chatgpt-subagent.ts
  - src/tools/subagent/chatgpt-subagent-observer.ts
  - src/tools/subagent/subagent-tools.ts
---

# Subagent Completion

## What This Is

This page defines how submitted subagent turns complete, recover, settle locally, and interact with durable agent conversation identity.

## Completion Authority

One authority completes normal turns: structured ChatGPT turn data observed directly through CDP. The observer accepts either `/backend-api/f/conversation` SSE (`Network.streamResourceContent` + `Network.dataReceived`) or `conversation-turn-*` WebSocket frames (`Network.webSocketFrameReceived`); both feed the same exact-prompt tracker.

The tracker binds only when a candidate stream contains the exact submitted user prompt. It then reconstructs assistant v1 text patches. Completion requires a final assistant message with `status: finished_successfully`, `end_turn: true`, recipient `all`/empty, plus an explicit stream-completion signal. Tool-call assistant messages such as `recipient: web.run` cannot complete the turn.

The same stream provides `conversation_id`; the runtime uses it to capture or construct the stable conversation URL stored on the owning agent. User-facing activity and transport liveness are tracked separately: assistant/tool messages update the activity label, while any bound turn-stream traffic also refreshes the turn's progress timestamp. This includes HTTP SSE heartbeats and non-message events such as `safety_review_update`.

There is no DOM completion observer or application-level `stream_status` polling.

## Recovery

Every submitted turn gets at most one catastrophic recovery attempt. A memory-backed turn with three minutes of no bound transport progress enters recovery; the hard idle limit remains 30 minutes. Regular SSE heartbeats keep a healthy long-running turn out of this path even when no assistant/tool message is visible. Observer/page failure follows the same recovery path. Recovery disposes the old observer and opens one fresh background page at the saved conversation URL. The recovery navigation reads ChatGPT's conversation payload once and completes locally only when it contains a final assistant answer after the exact submitted prompt.

Recovery never clicks Send, resubmits the prompt, or attaches a second turn observer. If that single history read has no matching final answer, or the recovery navigation fails, the turn fails immediately and releases global generation capacity, but the agent becomes `uncertain` because ChatGPT may still be processing upstream. That `agent_id` rejects later submissions with `AGENT_BUSY`; callers can use a new `agent_id` rather than risk overlapping turns in the same conversation.

This is separate from pre-submit restoration: a closed idle page or mismatched conversation URL is corrected before observation and submission, using the existing managed page when possible and one new background page otherwise.

## Detached Result Lifecycle

`subagent_run` returns after one successful submission. The submitted turn captures the launching caller's shared `AgentIdentity`; the observer or recovery path later queues exactly one `agent_finished agent_id=<agent_id> turn_id=<turn_id>` event for that captured parent. A different ChatGPT conversation cannot drain that notice because event draining uses the current request's `AgentIdentity`. No separate notification-session identifier is carried through the subagent API (`src/server/agent-context.ts`, `src/server/mcp-server.ts`, `src/tools/subagent/chatgpt-subagent.ts`).

`subagent_result(wait_ms)` only waits on the turn's local settlement promise. It never contacts ChatGPT, refreshes the browser, or performs reconciliation.

Completed/failed results remain available only in the current MCP process, even after idle cleanup closes the agent's page. The agent conversation URL and turn count are persisted separately in `~/.shellby/subagents.sqlite`, so context can survive process restart even though old `turn_id` results cannot (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/subagent-store.ts`).

## Invariants

1. Submit each requested turn at most once.
2. Same `agent_id` remains bound to the same ChatGPT conversation across background-page replacement and, when persistence succeeds, MCP process restart.
3. Raw CDP turn data is the only normal completion authority.
4. Bind a stream only to the exact submitted prompt.
5. Tool-call messages cannot masquerade as final answers.
6. `subagent_result` reads local state only.
7. Recovery may navigate and read conversation history once, but never resubmits.
8. Bound turn-stream traffic is liveness even when it does not change the user-facing activity label; a memory-backed turn gets one recovery attempt after three minutes without such progress, with a 30-minute hard idle limit.
9. An unreconciled submitted turn leaves its agent `uncertain` and unavailable for reuse.
10. Existing interaction/inter-turn delays and rate-limit cooldown remain in force.

## Related

- [Browser ChatGPT Subagents](./browser-chatgpt-subagents.md)
- [ChatGPT CDP Transport](./chatgpt-cdp-transport.md)
- [`subagent_run` / `subagent_result`](../tools/subagent.md)
