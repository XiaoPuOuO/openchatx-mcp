---
summary: "Session traceability for MCP callers, browser-subagent lineage correlation, live ChatGPT transport findings, known failure modes, and current best-effort behavior."
paths:
  - src/server/http-server.ts
  - src/server/audit-log.ts
  - src/server/mcp-server.ts
  - src/tools/subagent/chatgpt-subagent.ts
  - src/tools/subagent/chatgpt-subagent-observer.ts
  - src/tools/subagent/chatgpt-subagent-protocol.ts
  - src/tools/subagent/subagent-tools.ts
read_more:
  - pages/http-transport.md
  - pages/operations/audit-logging.md
  - pages/subagents/browser-chatgpt-subagents.md
---

# Subagent Tracking

## Goal

The traceability work started with two separate goals:

1. Identify which ChatGPT conversation made each MCP call by treating `X-OpenAI-Session` as the opaque conversation/session ID.
2. Distinguish browser-backed subagent callers from ordinary callers and, when possible, connect a child caller session to the parent session that launched it.

The first goal is directly supported by request metadata and is useful on its own. The second goal requires correlating two different ChatGPT surfaces and is much less certain.

## What `X-OpenAI-Session` Gives Us

Live ChatGPT MCP traffic carries `X-OpenAI-Session` on the HTTP request and `openai/session` in MCP metadata. Across sampled conversations, the value changes with the ChatGPT conversation while `X-OpenAI-Subject` remains stable for the user. Treat the session as opaque conversation-scoped operational context, not authorization state (`wiki/raw/openai-mcp-identity-observation-2026-08-09.md`, `src/server/http-server.ts`).

This is enough to answer the basic traceability question: which conversation called this tool? Runtime state keeps the full opaque session value, while audit output assigns each distinct session a short first-seen alias for readability:

```yaml
session: "agent-1"
```

The alias is presentation-only. `agent-1`, `agent-2`, and later values map to raw `X-OpenAI-Session` strings inside the logger for its lifetime; raw session IDs are still used for lineage correlation and detached NOTICE routing.

The same session can scope detached `agent_finished` NOTICE delivery so a completion launched from conversation A is not drained by unrelated conversation B. The launch request already knows A directly; no child-session inference is required for that delivery behavior (`src/server/mcp-server.ts`, `src/tools/subagent/subagent-tools.ts`, `src/tools/subagent/chatgpt-subagent.ts`).

## First Lineage Implementation

Commit `ae95680` added general session tracking and the first browser-subagent correlation attempt. Each subagent turn captured the launching parent's `X-OpenAI-Session`. The managed ChatGPT page's CDP stream observed assistant tool-call messages, while the HTTP MCP boundary observed incoming `tools/call` requests from the child conversation.

Because the browser-side ChatGPT session identifier is not the same value as the MCP `X-OpenAI-Session`, direct session comparison did not work. The implementation instead matched the tool name seen in the CDP tool-call message against the tool name seen on an incoming MCP call within a bounded time window. It supported either observation arriving first with two process-local buffers:

```text
pendingToolCalls: browser-observed calls waiting for MCP session
recentSessionToolCalls: MCP session calls waiting for browser observation
```

Once matched, the code remembered the child session as a browser subagent session.

Commit `728ce5f` corrected the conceptual model. `agent_id` is the reusable browser conversation identity used by `subagent_run`; it should not be used as MCP caller identity. The mapping became:

```text
child X-OpenAI-Session -> parent X-OpenAI-Session
```

Audit entries then used the child's own `session` plus optional `parent_session`. Presence of `parent_session` classified that caller as a known browser subagent.

## Problems With Heuristic Correlation

The implementation is acceptable as best-effort inference but has important weaknesses:

- The first child MCP call can finish before CDP exposes the matching assistant tool-call message, so its audit entry may lack lineage.
- Matching only by tool name can cross-wire two concurrent subagents that call the same tool within the correlation window.
- A short window can miss a subagent that waits before using Shellby.
- Increasing the window makes name-only matching more dangerous because more unrelated calls accumulate.
- Subagents commonly make many tool calls. Correlation cannot assume that only the first or next call matters. Any later unambiguous call should be able to establish the child session mapping.
- Once a child session is known, its later browser-observed tool calls still have to be reconciled against that child's incoming MCP calls. Otherwise the browser observation can remain pending and later attach an unrelated caller to the child's parent.

Live validation reproduced that stale-candidate failure: child B was correctly mapped to parent A, B later called `shell_run`, and the leftover browser-side `shell_run` candidate caused A's next ordinary `shell_run` to be incorrectly mapped as `A -> A`. The fix keeps known child sessions flowing through correlation. A known incoming child call consumes a matching pending browser observation for its already-known parent, or records a known recent call so a later browser observation can consume it without rebinding any session (`src/server/http-server.ts`, `src/tools/subagent/chatgpt-subagent.ts`).

If heuristic correlation were retained, matching `tool name + canonicalized arguments` would be substantially stronger than matching only the tool name. Object keys should be recursively sorted for comparison while array order remains significant. A five-minute buffer is then more defensible. The matcher should retain multiple calls from both sides and allow any exact match to bind the child session. Tool-name-only fallback should occur only when arguments are genuinely unavailable and exactly one candidate is unambiguous.

Even that remains inference. A missed mapping is preferable to attaching a child session to the wrong parent.

## Live ChatGPT Tool-Call Findings

Live probing on 2026-08-27 exposed more of the private ChatGPT connector stream than the current tracker retains.

An assistant connector call in the subagent CDP stream includes:

- a unique assistant message `id`;
- `recipient`, such as `api_tool.call_tool`;
- the connector payload containing the exact resource `path` and `args`;
- metadata including `request_id`, `turn_exchange_id`, `working_turn_id`, and `parent_id`.

A representative connector payload was shaped like:

```json
{ "path": "/Shellby MCP/<link>/shell_list", "args": {} }
```

The corresponding `role: "tool"` result message also appeared in the live CDP stream. It carried the same ChatGPT `request_id`, `turn_exchange_id`, and `working_turn_id`; its `parent_id` pointed to the assistant tool-call message; and its metadata contained `invoked_resource` identifying the Shellby MCP resource. This gives ChatGPT itself a deterministic call/result relationship inside the browser turn.

Completed conversation-history recovery did not expose these connector tool messages in the probe, so this information should be treated as live-stream evidence rather than durable conversation-history state.

## Better Deterministic Designs Worth Testing Later

The preferred future design is to find a real identifier that exists on both the browser/CDP side and the incoming MCP request, removing time-window correlation entirely.

First check whether incoming MCP `_meta` contains one of the ChatGPT identifiers already visible in CDP, especially `request_id` or `turn_exchange_id`. If one matches, lineage can be bound from a shared identifier with no tool-name or argument matching.

If ChatGPT does not forward such an identifier, another promising path is the tool result. Shellby knows the incoming child `X-OpenAI-Session` while producing the MCP result, and the known browser subagent turn observes that result through CDP. A custom result `_meta` field such as:

```text
shellby/session = <child X-OpenAI-Session>
```

could provide a direct join if ChatGPT preserves custom MCP result metadata into the CDP `role: "tool"` message. That behavior has not been proven yet. If custom `_meta` is stripped, a small machine-readable result marker could be tested before falling back to argument fingerprinting.

The deterministic model would be:

```text
browser subagent turn already knows parent session A
child MCP request arrives with session B
tool result observed in that browser turn exposes B
bind B -> A
```

After that first direct observation, every future MCP call carrying B is known to belong to the same child caller. No timeout or repeated matching is necessary.

## Current State

The repository currently retains best-effort lineage inference. Every tool call is still attributed directly to its own `X-OpenAI-Session`; known browser subagents additionally receive `parent_session` after correlation establishes `child session -> parent session`.

Live validation after restarting the current implementation showed that the basic model works in practice:

```text
parent A
└── child B
    └── grandchild C
```

Both `B -> A` and nested `C -> B` were learned correctly. The first child call can still lack `parent_session` because the browser and MCP observations race. Later calls use the remembered mapping.

The matcher remains heuristic and `parent_session` should therefore be treated as best-effort operational traceability rather than authoritative identity. A deterministic shared identifier remains the preferred future simplification. The stale-candidate false-positive described above is specifically guarded against, but same-tool races between still-unknown concurrent sessions remain possible.

## Validation Notes

At initial review time the session/lineage implementation passed the focused tests, the full 189-test suite, and TypeScript type-checking. A live child call also confirmed that ordinary caller and child MCP requests receive distinct `X-OpenAI-Session` values.

Later live validation exercised direct children, repeated calls, two concurrently launched subagents, and a nested grandchild. Correlation successfully learned direct and nested parent relationships. That same run exposed the stale known-child candidate bug that could produce a false self-parent mapping; regression coverage now verifies that known child calls consume their own candidates and that HTTP tool calls still pass through the reconciliation hook even after a session already has a known parent.

One live test initially showed the older `session-map` / `subagent:` audit format because the running MCP process had not yet loaded repository `HEAD`. Runtime process version must therefore be distinguished from checked-out source while validating this area. Server restart remains an operator action.
