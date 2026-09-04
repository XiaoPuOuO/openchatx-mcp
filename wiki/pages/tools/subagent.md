---
summary: "Caller-facing subagent_run and subagent_result contract for delegation, continuity, capacity, polling, completion, and failures."
paths:
  - src/tools/subagent/subagent-tools.ts
  - src/tools/subagent/chatgpt-subagent-contracts.ts
---

# `subagent_run` / `subagent_result`

## What This Is

Caller-facing contract for detached browser-backed ChatGPT delegation. Public tool descriptions and schemas are defined in `src/tools/subagent/subagent-tools.ts`. Browser implementation lives in [Browser ChatGPT Subagents](../subagents/browser-chatgpt-subagents.md); completion lives in [Subagent Completion](../subagents/subagent-completion.md).

## `subagent_run`

One call accepts one to three distinct agents. Each entry provides:

- `agent_id`: durable conversation identity within the calling MCP session; reuse it for multi-turn context. Conversation URL and turn count are persisted best-effort across MCP restarts.
- `prompt`: task for that turn.
- `memory`: optional flag controlling whether a new agent may restore persisted conversation state; defaults to `true`.

A new agent starts from the configured ChatGPT project URL when present. Its first prompt also receives the internal instructions `Oververbosity: 1.` and `Do not use \`subagent\` or \`computer_*\` tools.`Reused agents continue in or restore the same ChatGPT conversation. At most three generations run concurrently per calling MCP session. Different main-agent sessions can reuse the same`agent_id` independently. Three-entry batches retain the existing staggered submission delays.

## `subagent_result`

Pass one to three returned `turn_id` values. Results are retrieved concurrently from local turn state:

- `running`: may include `activity` and `activity_age_ms`;
- `completed`: includes `response`;
- `failed`: includes `error`.

`wait_ms` defaults to 30 seconds and waits on the local settlement promise only. Use `0` only for an immediate status check. Agent turns average about 3 minute and may run up to 30 minutes. It never polls or reloads ChatGPT.

Activity remains one of `Working`, `Searching the web`, `Using tools`, or `Generating response`.

Compact results separate returned turns with top-level metadata headers and place completed responses directly beneath them:

```text
---- turn_id=reviewer_turn_1 status=completed ----

## Review
...

---- turn_id=tester_turn_1 status=running activity="Using tools" activity_age_ms=2750 ----
```

## Lifetime and Failures

Turn records and prior `turn_id` results are process-local. The calling `X-OpenAI-Session`, `agent_id`, conversation URL, and turn count form the persisted mapping in `~/.shellby/subagents.sqlite`, so the same main-agent session can reuse an `agent_id` after restart without colliding with another session's agent of the same name. `npm run reset-agents` intentionally clears those mappings (`src/tools/subagent/subagent-store.ts`, `scripts/reset-agents.mjs`).

After 30 idle minutes, only the managed background page closes; the saved conversation identity and prior results remain. A later call restores that conversation. Submitted turns also have a 30-minute no-progress cutoff and one recovery attempt that reopens and reads the saved conversation once but never resubmits the prompt or waits on a second observer. If recovery cannot prove the submitted turn finished, that agent is marked `uncertain` and rejects later prompts with `AGENT_BUSY`; use a new `agent_id` instead of risking an overlapping upstream turn.

Important failures include `BROWSER_UNAVAILABLE`, `CHATGPT_NOT_AUTHENTICATED`, `AGENT_BUSY`, `SUBAGENT_CAPACITY_REACHED`, `AGENT_TARGET_LOST`, `AGENT_IDLE_EXPIRED`, `UNKNOWN_TURN`, `REQUEST_ABORTED`, and `CHATGPT_UI_CHANGED`.

Detached completion queues one `agent_finished` event for delivery on the next MCP tool response; retrieve the answer with `subagent_result`.

## Related

- [Browser ChatGPT Subagents](../subagents/browser-chatgpt-subagents.md)
- [Subagent Completion](../subagents/subagent-completion.md)
- [MCP Tool Surface](../mcp-tool-surface.md)
