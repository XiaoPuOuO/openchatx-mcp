---
summary: "Caller-facing subagent_run and subagent_result contract for delegation, continuity, capacity, polling, completion, and failures."
paths:
  - src/tools/delegation/subagent-tools.ts
  - src/tools/delegation/contracts.ts
  - src/tools/delegation/chatgpt-service.ts
  - src/config.ts
  - src/public-config.cts
---

# `subagent_run` / `subagent_result`

## What This Is

Caller-facing contract for detached browser-backed ChatGPT delegation. Public tool descriptions and schemas are defined in `src/tools/delegation/subagent-tools.ts`. Browser implementation lives in [Browser ChatGPT Subagents](../subagents/browser-chatgpt-subagents.md); completion lives in [Subagent Completion](../subagents/subagent-completion.md).

## `subagent_run`

One call accepts one to three distinct agents. Each entry provides:

- `agent_id`: durable conversation identity within the calling MCP session; reuse it for multi-turn context. Conversation URL and turn count are persisted best-effort across MCP restarts.
- `prompt`: task for that turn.
- `memory`: chosen when creating an agent; defaults to `true`. With `false`, a new agent starts a temporary ChatGPT chat and skips persisted lookup/save. Its live page still supports follow-up turns, but cannot restore context after page loss or process restart. Supplying a different flag when reusing a live ID does not change that agent’s mode.

A new memory-backed agent starts from the configured ChatGPT project URL. Its first prompt receives the internal instructions described in [Browser ChatGPT Subagents](../subagents/browser-chatgpt-subagents.md). Reused agents continue in or restore the same ChatGPT conversation. Each main-agent session may own at most `chatgpt.max_delegated_agents` delegated agent IDs total across subagents and clones (default `3`); existing IDs can receive unlimited follow-up turns. The limit counts persisted mappings, live IDs, and in-flight creations. It controls admission of new IDs, not a separate running-turn semaphore. Lowering the limit preserves reuse of all existing IDs, even when their count exceeds the new value. The per-call batch limit remains three. Different main-agent sessions can reuse the same `agent_id` independently. Three-entry batches retain the existing staggered submission delays.

## `subagent_result`

Pass one to three returned `turn_id` values. Results are retrieved concurrently from local turn state:

- `running`: may include `activity` and `activity_age_ms`;
- `completed`: includes `response`;
- `failed`: includes `error`.

The MCP result sets `isError: true` whenever any returned turn has `status: failed`, including unknown turn IDs and polling failures. Mixed batches preserve every turn and any successful responses. Batches containing only running or completed turns set `isError: false`. This applies in compact and structured output modes, and a failed batch stops `then_run` chaining.

`wait_ms` defaults to 30 seconds and waits on the local settlement promise only. Use `0` only for an immediate status check. This wait does not impose a generation deadline; no-progress recovery is separate. It never polls or reloads ChatGPT.

Activity remains one of `Working`, `Searching the web`, `Using tools`, or `Generating response`.

Compact results separate returned turns with top-level metadata headers and place completed responses directly beneath them:

```text
---- turn_id=reviewer_turn_1 status=completed ----

## Review
...

---- turn_id=tester_turn_1 status=running activity="Using tools" activity_age_ms=2750 ----
```

## Lifetime and Failures

Turn records and prior `turn_id` results are process-local. The calling `X-OpenAI-Session`, `agent_id`, conversation URL, and turn count form the persisted mapping in `<state_dir>/subagents.sqlite`, so the same main-agent session can reuse an `agent_id` after restart without colliding with another session's agent of the same name. `npm run reset-agents` intentionally clears those mappings (`src/tools/delegation/store.ts`, `scripts/chatgpt/reset-delegation-state.ts`).

After 30 idle minutes, the managed background page closes; saved conversation identity and prior local results remain. A later call restores a memory-backed conversation. Temporary chats have no saved URL for restoration. Idle cleanup marks their retained agent record as expired; later prompts return `TEMP_AGENT_EXPIRED` before browser reconnection. The message explains that cleanup closed the temporary agent after 30 minutes of inactivity and its conversation cannot be resumed. Changing `memory` on reuse does not bypass expiration. The marker and completed results remain process-local; other page loss retains the existing `AGENT_TARGET_LOST` behavior.

Memory-backed turns enter one-shot recovery after three minutes without bound progress; observer failures also trigger recovery. Other active turns retain a 30-minute no-progress cutoff. Recovery reopens and reads the saved conversation once, never resubmits the prompt, and never waits on a second observer. If recovery cannot prove the submitted turn finished, that agent is marked `uncertain` and rejects later prompts with `AGENT_BUSY`; use another existing agent ID, or a new ID when a delegated-agent slot is available, instead of risking an overlapping upstream turn.

Caller-facing failures include `SUBAGENT_UNAVAILABLE`, `AGENT_BUSY`, `AGENT_LIMIT_REACHED`, `SUBAGENT_RATE_LIMITED`, `SUBAGENT_PERSISTENCE_UNAVAILABLE`, `AGENT_TARGET_LOST`, `AGENT_IDLE_EXPIRED`, `TEMP_AGENT_EXPIRED`, `UNKNOWN_TURN`, and `REQUEST_ABORTED`. `SUBAGENT_PERSISTENCE_UNAVAILABLE` means durable restoration/capacity state could not be read safely; the rejected call did not submit a new prompt. Backend-specific availability, authentication, and UI failures are projected as `SUBAGENT_UNAVAILABLE`; callers may retry the same subagent call once, then continue without delegation if it fails again. The guidance explicitly discourages changing the task or prompt as a workaround. Other backend implementation details remain inside the subagent runtime. `AGENT_LIMIT_REACHED` lists the delegated agent IDs already owned by that main agent and each agent's latest known turn ID so the caller can reuse one.

Detached completion queues one `agent_finished` event for delivery on the next MCP tool response; retrieve the answer with `subagent_result`.

## Related

- [Browser ChatGPT Subagents](../subagents/browser-chatgpt-subagents.md)
- [Subagent Completion](../subagents/subagent-completion.md)
- [MCP Tool Surface](../mcp-tool-surface.md)
