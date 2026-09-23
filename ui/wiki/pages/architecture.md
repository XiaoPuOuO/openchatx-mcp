---
summary: "Dashboard data flow, component ownership, API boundary, steering behavior, and tool-call inspection."
paths:
  - src/App.tsx
  - vite.config.ts
  - src/hooks/useAgents.ts
  - src/lib/api.ts
  - src/types.ts
  - src/features/dashboard/
  - src/features/agent-room/
---

# Runtime and Interaction Map

## Data Flow

`useAgents` starts one `GET /ui/api/agents` snapshot and opens `EventSource("/ui/api/events")` concurrently. Snapshot merge keeps any newer agent values already received through SSE. Each `agent_changed` event replaces that agent in place by ID; newly observed agents append. The initial snapshot determines card order so concurrent activity does not make agent cards trade positions while the dashboard is being watched.

SSE reconnect does not fetch another snapshot or replay missed events. An agent unchanged after reconnection may remain stale until a later event or page refresh. Preserve the initial snapshot/SSE merge when changing startup behavior.

Browser types in `src/types.ts` mirror observer snapshots: agent identity/task slug, current call, recent calls, and steering instructions. Keep changes aligned with server observer payloads in root repo `src/agent/observer.ts`.

## Component Ownership

| Area | Owner | Durable behavior |
| --- | --- | --- |
| Page shell / connection indicator | `src/App.tsx` | Active means `lastSeenAt` within 30 seconds. |
| Per-agent composition | `src/features/dashboard/AgentCard.tsx` | Room, recent activity, steering, call modal. |
| Live data | `src/hooks/useAgents.ts` | Snapshot + SSE replacement model. |
| API calls | `src/lib/api.ts` | Relative `/ui/api/...` URLs only. |
| Steering | `src/features/dashboard/SteerComposer.tsx` | Queue on server; cancel queued instruction; delivered dismissal local only. |
| Tool details | `src/features/dashboard/ToolCallModal.tsx` | Show captured call detail with limited highlight.js languages. |
| Agent room | `src/features/agent-room/` | Canvas runtime, layout/rendering, Pixel Agents catalog/storage, and editor. |
| Room editor | `src/features/agent-room/editor/RoomEditor.tsx` | Orchestrate editor state, pointer behavior, persistence, and layout mutation. |

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

Backend transport lives in root repo `src/server/http-server.ts`; dashboard routes and observer state live in `src/agent/`. Server configuration and local-only exposure are documented in [HTTP Transport](../../../wiki/pages/http-transport.md). Tool execution/steering delivery lives in `src/mcp/tool-registration-boundary.ts`.

Production assets use the same configured port as MCP. The Vite development proxy reads root `port` from the repository's `.shellby/config.toml` through the shared public config loader, so a second repository copy points at its own backend. Run config-only setup if the file is missing before invoking Vite (`vite.config.ts`, `../src/public-config.cts`).
