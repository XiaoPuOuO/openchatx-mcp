---
summary: "Browser-backed ChatGPT subagent lifecycle, conversation persistence, page ownership, submission, and recovery behavior."
paths:
  - src/tools/subagent/
  - scripts/chatgpt-browser.mjs
---

# Browser ChatGPT Subagents

## What This Is

This page documents the browser-backed ChatGPT subagent runtime, including durable conversation identity, page ownership, submission, restoration, and project routing.

## Model

`subagent_run` uses the authenticated dedicated Chrome only as a ChatGPT client. Each `agent_id` owns a conversation identity and, while active, one managed background page. Conversation URL and turn count are persisted best-effort in `~/.shellby/subagents.sqlite`, so a later MCP process can restore the same ChatGPT conversation. A new agent opens `MCP_CHATGPT_PROJECT_URL` when configured, otherwise `https://chatgpt.com/` (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/subagent-store.ts`).

Normal completion comes from raw CDP streams: `/backend-api/f/conversation` SSE and `conversation-turn-*` WebSocket frames feed the same exact-prompt tracker. Rendered DOM and application-level polling are not completion sources. Conversation history is read only during the single catastrophic recovery attempt.

## Runtime State

One process-level service owns:

```text
agents: agent_id -> lifecycle status + optional page + conversation URL + turn counter + timestamps
turns: turn_id -> detached local turn state
activeOperations: agent_id -> reserved/submitted turn
pendingEvents: launching MCP session -> completion notifications
store: SQLite agent_id -> conversation URL + turn count
```

The agent lifecycle reuses the existing activity values: `Working`, `Searching the web`, `Using tools`, and `Generating response`, plus `idle` and `uncertain`. `activeOperations` remains only the concurrency/race lock. Live turns, responses, activity, pending events, pages, and uncertain status are process-local. The persisted store keeps only conversation URL and turn count (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/subagent-store.ts`).

The launching MCP session is retained only so a detached `agent_finished` event returns to the conversation that started the turn. Shellby does not infer whether later MCP callers are subagents and does not build relationships between caller sessions. See [Session Tracking](./subagent-tracking.md).

## Submission

For each turn `askSubagent()`:

1. enforces the existing rate-limit cooldown and three-generation cap;
2. reuses the expected page, navigates a mismatched managed page to the saved conversation, or opens one replacement background page;
3. keeps the configured inter-turn delay;
4. installs the raw CDP turn observer before submission;
5. finds the composer;
6. keeps the configured interaction delays;
7. enters the prompt;
8. keeps the shared pre-submit grace and final rate-limit check;
9. clicks Send once;
10. records detached local turn state and returns `turn_id`.

The first-turn prompt contract is unchanged: oververbosity `1` selects caveman `ultra`, `2` selects `full`, `3` selects `lite`, `4` selects `lite` plus its completeness qualifier, and `5` injects nothing. Later turns send only the caller prompt.

## Multi-turn and Projects

A project URL matters when creating the first conversation. ChatGPT owns the resulting conversation and project context; the runtime stores its stable URL and derives the conversation ID from that URL when needed.

Before submission, the page must match that saved identity. A mismatched open page is navigated to the correct URL; a closed or unusable page is replaced with one background page. The prompt is still submitted at most once.

After 30 minutes without an active turn, cleanup closes only the background page and retains the agent, conversation reference, and turn count. A later call with the same `agent_id` reopens the saved conversation. After process restart, first reuse loads the stored conversation URL and turn count and navigates a fresh background page there. `npm run reset-agents` deletes the SQLite store when an operator intentionally wants to forget persisted agent mappings. A submitted turn with 30 minutes of no observed progress enters the one-shot history recovery path described in [Subagent Completion](./subagent-completion.md) (`scripts/reset-agents.mjs`, `src/tools/subagent/chatgpt-subagent.ts`).

## Code Map

| Location                                          | Responsibility                                                 |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `src/tools/subagent/chatgpt-subagent.ts`          | agent/turn state, pacing, rate limits, submission, completion  |
| `src/tools/subagent/chatgpt-subagent-browser.ts`  | background page and minimal composer interaction               |
| `src/tools/subagent/chatgpt-subagent-observer.ts` | one raw CDP HTTP/WebSocket observation per turn                |
| `src/tools/subagent/chatgpt-subagent-protocol.ts` | exact-prompt binding and assistant delta reconstruction        |
| `src/tools/subagent/subagent-store.ts`            | best-effort SQLite conversation URL and turn-count persistence |
| `src/tools/subagent/subagent-tools.ts`            | unchanged public MCP schemas and batching                      |

## Related

- [`subagent_run` / `subagent_result`](../tools/subagent.md)
- [Subagent Completion](./subagent-completion.md)
- [ChatGPT CDP Transport](./chatgpt-cdp-transport.md)
- [Build and Test](../operations/build-and-test.md)
