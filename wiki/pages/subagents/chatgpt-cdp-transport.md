---
summary: "Observed private ChatGPT Web turn transport used by Shellby's raw-CDP subagent completion tracker."
paths:
  - src/tools/delegation/response-observer.ts
  - src/tools/delegation/turn-protocol.ts
  - src/tools/delegation/chatgpt-service.ts
  - scripts/chatgpt/cdp-probe.mjs
  - scripts/chatgpt/summarize-cdp-probe.mjs
---

# ChatGPT CDP Transport

## What This Is

This page records the private ChatGPT Web transport behavior Shellby's subagent completion tracker currently relies on.

## Observed Transport

Submitting in ChatGPT Web starts through `/backend-api/f/conversation`, then generation continues on ChatGPT's authenticated WebSocket. Turn traffic is published on topics shaped like `conversation-turn-<turn-id>` and contains encoded SSE-style stream items.

Observed stream data includes the submitted user message, assistant/tool messages, incremental v1 patches, `conversation_id`, `message_stream_complete`, and explicit turn completion. Source Markdown and fenced code are preserved in the structured stream.

Raw CDP also proved that `/backend-api/f/conversation` can be consumed incrementally with `Network.streamResourceContent` plus `Network.dataReceived`. The production tracker accepts that HTTP path because current ChatGPT/project sessions may choose either transport.

Long-running turns can remain alive without producing assistant/tool messages for several minutes. During the observed ChatGPT UI state that says "Our systems are thinking a bit more about this request before responding," the HTTP conversation stream emitted a `safety_review_update` event and then continued sending SSE comment heartbeats shaped like `: ping - <timestamp>` about every 15 seconds. These are transport-liveness signals even when they do not represent user-visible activity.

Once the exact submitted prompt binds a tracker to a source, every subsequent non-empty turn-stream block refreshes the turn's activity timestamp, including SSE comment heartbeats, `safety_review_update`, assistant/tool messages, deltas, and matching WebSocket stream items. Only events with a meaningful coarse label update the displayed activity string; unlabeled heartbeats still reset `activity_age_ms`. Heartbeats received before exact-prompt binding do not count.

## CDP Probe

`scripts/chatgpt/cdp-probe.mjs` is a manual diagnostic recorder for the dedicated authenticated ChatGPT Chrome. It attaches to the configured CDP endpoint and records JSONL evidence without launching, closing, reloading, or navigating Chrome. It is intended for investigating private transport changes and subagent liveness failures against the real ChatGPT Web client.

Start a capture before reproducing the behavior:

```sh
npm run probe:chatgpt-cdp -- --capture-bodies
```

Run the subagent scenario, then stop the probe with Ctrl-C. Captures are written under ignored `test/live/artifacts/` by default. The probe records raw CDP network/WebSocket events, decoded conversation SSE chunks when body capture is enabled, page lifecycle/runtime events, and lightweight DOM state useful for correlating transport behavior with what ChatGPT displays.

Summarize a saved trace with:

```sh
npm run probe:chatgpt-cdp:summary -- test/live/artifacts/<trace>.jsonl
```

The summarizer reports event counts, candidate transport-liveness gaps, and captured DOM streaming states. It is useful for answering whether Chrome stopped receiving turn traffic or whether Shellby's production tracker ignored traffic that was still arriving.

The recorder redacts sensitive request headers and token-like URL query values, but captured conversation bodies can still contain prompts, responses, and other private conversation data. Treat trace files as private diagnostic artifacts and do not commit them.

## Production Choice

Subagents install one CDP observer before submission so early turn events cannot be missed. It feeds the same tracker from either HTTP SSE or WebSocket turn data:

```text
browser UI -> submit prompt
raw CDP HTTP/WS -> bind exact prompt -> reconstruct final assistant -> complete local turn
```

The DOM remains necessary for composer interaction only. It is not a completion or recovery source; the one-shot catastrophic recovery uses the conversation JSON captured during one recovery navigation, without a second turn observer.

## Rate-limit Finding

Earlier probes showed that extra conversation-history/reload traffic could contribute to ChatGPT's conversation-history rate limit. The runtime performs no normal conversation-history fetch, `stream_status` request, or reload. It permits one conversation navigation/history response after observer/page failure or three minutes without bound progress for a memory-backed turn. A separate 30-minute no-progress cutoff remains for other active turns. See [Subagent Completion](./subagent-completion.md). The existing UI modal detection, cooldown, inter-turn delay, interaction delays, and pre-submit grace remain.

ChatGPT's own frontend may still issue its own bootstrap/history traffic; the runtime cannot prevent upstream client behavior.

## Private Protocol Risk

The HTTP/turn-WebSocket schemas are private and can change. Deterministic protocol tests and the manual two-turn live canary are the compatibility boundary. A schema change gets one bounded recovery attempt, then fails the turn clearly.

When the private protocol appears to drift, use the CDP probe to establish the current browser behavior before changing the production parser. Prefer stable structured transport signals over DOM text or CSS selectors when both expose the same state.

## Related

- [Browser ChatGPT Subagents](./browser-chatgpt-subagents.md)
- [Subagent Completion](./subagent-completion.md)
- [Build and Test](../operations/build-and-test.md)
