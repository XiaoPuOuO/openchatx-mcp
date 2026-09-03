---
summary: "Simple MCP caller identity tracking, audit labels, completion-event routing, and historical findings from the removed subagent-lineage experiment."
paths:
  - src/server/agent-context.ts
  - src/server/http-server.ts
  - src/server/audit/
  - src/server/mcp-server.ts
  - src/tools/subagent/chatgpt-subagent.ts
  - src/tools/subagent/subagent-tools.ts
read_more:
  - pages/http-transport.md
  - pages/operations/audit-logging.md
  - pages/subagents/browser-chatgpt-subagents.md
---

# Session Tracking

## Current Model

Shellby tracks only the ChatGPT conversation that made each MCP request. The HTTP boundary passes `X-OpenAI-Session` into the process-local agent context, which owns the canonical identity for that caller:

```text
X-OpenAI-Session -> { sessionId, agent, taskSlug }
```

No attempt is made to classify a caller as a browser subagent or infer relationships between sessions. For `subagent_run`, the caller's `AgentIdentity` is the runtime ownership boundary: `agent_id` is reusable within that identity, and persistence derives only its stable `sessionId` when writing the SQLite mapping.

Each distinct session receives a short first-seen `agent-N` identity from `agent-context.ts`:

```yaml
session: "agent-1"
```

The next distinct caller becomes `agent-2`, then `agent-3`, and so on for the process lifetime. After a successful `start_here`, its caller-provided task slug becomes part of the same identity. Audit entries format that as `agent-1/audit-session-labels`; reviews and other runtime features consume the same identity (`src/server/agent-context.ts`, `src/server/http-server.ts`, `src/server/audit/audit-log.ts`, `src/tools/start-here/start-here.ts`).

## Completion Events

Each submitted subagent or clone turn captures the launching request's `AgentIdentity`. When that detached turn completes, including through recovery work driven by the service cleanup timer, `agent_finished` is queued against that captured identity. A later MCP response drains events for its current `AgentIdentity`. This preserves direct parent notification without carrying a separate notification session ID through the subagent API (`src/server/agent-context.ts`, `src/server/mcp-server.ts`, `src/tools/subagent/chatgpt-subagent.ts`).

## Removed Lineage Experiment

Two earlier commits attempted to infer browser-subagent relationships by correlating ChatGPT Web CDP tool-call messages with incoming MCP calls. The browser turn knew the launching session, while the MCP request exposed the caller's `X-OpenAI-Session`. Because those surfaces did not expose a proven shared identifier, the implementation matched tool names within a short time window and stored inferred relationships process-locally.

Live testing showed why this was unsafe:

- separate ChatGPT conversations do receive distinct full `X-OpenAI-Session` values even though all sampled values shared a `v1/` prefix;
- direct child and nested calls sometimes correlated correctly;
- the first child call could race the CDP observation and remain unclassified;
- repeated/common tool names created stale candidates;
- a stale candidate reproduced a false self-association after a normal caller used the same tool;
- nested testing reproduced another false association after a grandchild used `shell_run` and the root caller later used `shell_run`;
- matching tool name plus canonicalized arguments would reduce collisions but would still be heuristic.

The entire correlation path was therefore removed: no correlation TTL, pending/recent call buffers, child-session map, HTTP matcher, or CDP tool-call callback remains.

## Useful CDP Findings

The removed experiment still produced useful private-transport observations. Live assistant connector calls exposed a unique message ID plus metadata such as `request_id`, `turn_exchange_id`, `working_turn_id`, and `parent_id`. The corresponding live `role: "tool"` result carried matching turn identifiers and pointed back to the assistant call through `parent_id`.

Those observations prove ChatGPT has deterministic call/result linkage inside the browser stream. They do not prove that any of those identifiers reach Shellby's incoming MCP request. A future lineage design should only be reconsidered if a real identifier is observed on both sides, or another deterministic join is proven. Do not restore time-window or tool-name inference.

## Invariant

Keep session tracking boring:

```text
one MCP caller session -> one AgentIdentity
```

Audit output answers which conversation called Shellby. It does not claim how that conversation relates to any other conversation.
