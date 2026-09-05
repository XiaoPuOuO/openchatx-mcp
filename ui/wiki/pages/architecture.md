---
summary: "Dashboard data flow, component ownership, API boundary, steering behavior, and tool-call inspection."
paths:
  - src/App.tsx
  - src/hooks/useAgents.ts
  - src/lib/api.ts
  - src/types.ts
  - src/components/AgentCard.tsx
  - src/components/SteerComposer.tsx
  - src/components/ToolCallModal.tsx
---

# Runtime and Interaction Map

## Data Flow

`useAgents` performs one `GET /ui/api/agents` snapshot, then opens `EventSource("/ui/api/events")`. Each `agent_changed` event replaces that agent by ID and resorts list by `lastSeenAt`.

Browser types in `src/types.ts` mirror observer snapshots: agent identity/task slug, current call, recent calls, and steering instructions. Keep changes aligned with server observer payloads in root repo `src/server/agent-observer.ts`.

## Component Ownership

| Area | Owner | Durable behavior |
| --- | --- | --- |
| Page shell / connection indicator | `src/App.tsx` | Active means `lastSeenAt` within 30 seconds. |
| Per-agent composition | `src/components/AgentCard.tsx` | Room, recent activity, steering, call modal. |
| Live data | `src/hooks/useAgents.ts` | Snapshot + SSE replacement model. |
| API calls | `src/lib/api.ts` | Relative `/ui/api/...` URLs only. |
| Steering | `src/components/SteerComposer.tsx` | Queue on server; cancel queued instruction; delivered dismissal local only. |
| Tool details | `src/components/ToolCallModal.tsx` | Show captured call detail with limited highlight.js languages. |

## Steering Contract

`POST /ui/api/agents/:agentId/steer` queues human instruction. Server injects queued instruction into current or next tool response at tool-registration boundary. `DELETE /ui/api/agents/:agentId/instructions/:instructionId` cancels only still-queued instruction.

UI status meanings:

- amber clock: queued on server;
- green check: delivered by server;
- red alert: request failed;
- `Dismiss` for delivered status changes local presentation only.

## Tool Calls

Recent list includes current call followed by retained recent calls. Row click opens modal. `detail` is display-only captured input; `detailLanguage` selects bash, diff, or JSON highlighting when available.

Do not derive operational truth from pixel-room queue. Room intentionally lags fast calls for readability. See [Agent Room](./agent-room.md).

## Server Boundary

Backend routes and static serving live in root repo `src/server/http-server.ts`. Tool observation and steering delivery live in `src/server/agent-observer.ts` and `src/server/tool-registration-boundary.ts`.
