---
summary: "Browser-backed ChatGPT subagent lifecycle, conversation persistence, page ownership, submission, and recovery behavior."
paths:
  - src/tools/delegation/
  - scripts/chatgpt/browser.mjs
---

# Browser ChatGPT Subagents

## What This Is

This page documents the browser-backed ChatGPT subagent runtime, including durable conversation identity, page ownership, submission, restoration, and project routing.

## Model

`subagent_run` uses the authenticated dedicated Chrome only as a ChatGPT client. Runtime ownership follows the caller's canonical `AgentIdentity`; each `agent_id` is unique within that owner and, while active, owns one managed background page. Persistence stores `AgentIdentity.sessionId` with the conversation URL and turn count so a later MCP process can restore the same ChatGPT conversation. A new agent opens the active `.shellby/config.toml` `chatgpt.project_url` (`src/config.ts`, `src/tools/delegation/chatgpt-service.ts`, `src/tools/delegation/store.ts`).

Normal completion comes from raw CDP streams: `/backend-api/f/conversation` SSE and `conversation-turn-*` WebSocket frames feed the same exact-prompt tracker. Rendered DOM and application-level polling are not completion sources. Conversation history is read only during the single catastrophic recovery attempt.

## Runtime State

One process-level service composes browser orchestration with a `DelegationLifecycle` state owner. The lifecycle component owns:

```text
scopes: AgentIdentity -> {
  agents: agent_id -> lifecycle status + optional page + conversation URL + turn counter + timestamps
  turns: turn_id -> detached local turn state
  activeOperations: agent_id -> reserved/submitted turn
  pendingEvents: completion notifications
}
store: SQLite (AgentIdentity.sessionId, agent_id) -> conversation URL + turn count, with explicit available/unavailable state
```

The lifecycle component owns scope maps, admission/capacity checks, persisted-agent hydration, turn settlement, completion-event queues, and idle-expiry decisions. The browser orchestrator owns Chrome connection, page navigation/submission, CDP observation, rate-limit UI handling, and recovery. The agent lifecycle reuses the existing activity values: `Working`, `Searching the web`, `Using tools`, and `Generating response`, plus `idle` and `uncertain`. `activeOperations` remains only the concurrency/race lock. Live turns, responses, activity, pending events, pages, and uncertain status are process-local. The persisted store keeps only conversation URL and turn count. Store initialization/read/write failures are logged and put the store into an explicit unavailable state (`src/tools/delegation/lifecycle.ts`, `src/tools/delegation/chatgpt-service.ts`, `src/tools/delegation/store.ts`).

Delegation admission fails closed with `SUBAGENT_PERSISTENCE_UNAVAILABLE` when persisted capacity/restoration state cannot be read safely. Service construction itself remains available so unrelated MCP tools continue to work. If persistence fails only after a prompt has already been submitted, the detached turn remains valid and continues to completion; that write failure is logged but is not returned as a failed submission, avoiding a retry of an already-sent prompt. Later delegated submissions fail before Send until the service/store is healthy again.

The launching MCP session is retained only so a detached `agent_finished` event returns to the conversation that started the turn. Shellby does not infer whether later MCP callers are subagents and does not build relationships between caller sessions. See [Session Tracking](./subagent-tracking.md).

## Submission

For each turn `askSubagent()`:

1. enforces the rate-limit cooldown and configured `chatgpt.max_delegated_agents` cap (default `3`) for the calling main-agent session;
2. reuses the expected page, navigates a mismatched managed page to the saved conversation, or opens one replacement background page;
3. keeps the configured inter-turn delay;
4. installs the raw CDP turn observer before submission;
5. finds the composer;
6. keeps the configured interaction delays;
7. enters the prompt;
8. keeps the shared pre-submit grace and final rate-limit check;
9. clicks Send once;
10. records detached local turn state and returns `turn_id`.

The first subagent turn appends `Oververbosity: 1.` and a prohibition on subagent tools; the prohibition includes `computer_*` only when Computer Use is enabled. Later turns send only the caller prompt. Clones preserve branched context and do not receive this first-subagent-turn injection. Verbosity is intentionally not part of the public subagent tool contract.

## Multi-turn and Projects

A project URL matters when creating the first conversation. ChatGPT owns the resulting conversation and project context; the runtime stores its stable URL and derives the conversation ID from that URL when needed.

Before submission, the page must match that saved identity. A mismatched open page is navigated to the correct URL; a closed or unusable page is replaced with one background page. The prompt is still submitted at most once.

After 30 minutes without an active turn, cleanup closes only the background page and retains the agent, conversation reference, and turn count. Temporary-agent expiration and page removal are committed only after the idle page close succeeds or the page is confirmed closed; a failed close leaves the live temporary agent resumable and eligible for a later cleanup retry. For memory-backed agents, a later call from the same main-agent session with the same `agent_id` reopens the saved conversation. After process restart, first reuse loads the stored conversation URL and turn count and navigates a fresh background page there. Temporary agents cannot restore a successfully closed conversation; idle cleanup records expiration and reuse returns the specific error described in [Lifetime and Failures](../tools/subagent.md#lifetime-and-failures). `npm run reset-agents` deletes the SQLite store when an operator intentionally wants to forget persisted agent mappings. A submitted turn with 30 minutes of no observed progress enters the one-shot history recovery path described in [Subagent Completion](./subagent-completion.md) (`scripts/chatgpt/reset-delegation-state.ts`, `src/tools/delegation/chatgpt-service.ts`).

## Code Map

| Location                                      | Responsibility                                                 |
| --------------------------------------------- | -------------------------------------------------------------- |
| `src/tools/delegation/chatgpt-service.ts`     | browser connection, submission, CDP observation, recovery, pacing, rate limits |
| `src/tools/delegation/lifecycle.ts`           | scoped agent/turn state, admission, persistence hydration, settlement, events, idle decisions |
| `src/tools/delegation/chatgpt-browser.ts`     | background page and minimal composer interaction               |
| `src/tools/delegation/response-observer.ts`   | one raw CDP HTTP/WebSocket observation per turn                |
| `src/tools/delegation/turn-protocol.ts`       | exact-prompt binding and assistant delta reconstruction        |
| `src/tools/delegation/store.ts`               | SQLite conversation persistence with explicit failure state and operational logging |
| `src/tools/delegation/subagent-tools.ts`      | unchanged public subagent MCP schemas and batching             |
| `src/tools/delegation/clone-tools.ts`         | unchanged public clone MCP schemas and batching                |

## Related

- [`subagent_run` / `subagent_result`](../tools/subagent.md)
- [Subagent Completion](./subagent-completion.md)
- [ChatGPT CDP Transport](./chatgpt-cdp-transport.md)
- [Build and Test](../operations/build-and-test.md)
