---
summary: "Mandatory startup context for Shellby Control, the optional local agent dashboard."
---

# Project Overview

## What This Is

Shellby Control is optional local React dashboard for observing and steering Shellby MCP agents. Production UI ships as static assets from same Shellby Express process and same port as MCP. No separate production frontend server.

Dashboard is observer, control surface, and visualization layer. Server-side `AgentObserver` owns agent call history and steering instructions. UI adds presentation-only state such as selected modal rows and queued pixel-room animations.

## Engineering Approach

- Keep UI small and direct. React components own ordinary interaction state; imperative Canvas engine owns pixel-room animation.
- React Compiler enabled. Avoid manual memoization unless measured need exists.
- Prefer low-color application chrome. Reserve semantic color for active, failed, queued, delivered, and connection states.
- Pixel-room visuals use bundled Pixel Agents assets and ideas under MIT attribution. Keep Shellby-specific tool mapping and animation behavior local.
- Do not make visualization timing authoritative. Recent activity, call status, and steering status come from server snapshots/events.

## Global Invariants

- All browser paths live under `/ui/`; API lives under `/ui/api/`.
- UI availability follows server `ui.enabled`. Disabled server UI means no observer, API, SSE, or static dashboard.
- Initial agent state comes from HTTP snapshot; live changes come from SSE. UI must tolerate reconnect without treating Canvas animation state as source of truth.
- Production build output is `ui/dist`; Shellby server serves it directly.

## Route Next

- [Runtime and Interaction Map](./architecture.md)
- [Agent Room](./agent-room.md)
