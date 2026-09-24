---
summary: "Mandatory startup context for the openchatx-mcp local dashboard."
---

# Project Overview

## What This Is

openchatx-mcp includes an optional local React dashboard for observing and steering MCP agents. Production UI ships as static assets from the same Express process and port as MCP. No separate production frontend server.

Dashboard is an observer and control layer. Server-side `AgentObserver` owns agent call history and steering instructions. UI adds presentation-only state such as selected modal rows.

## Engineering Approach

- Keep UI small and direct. React components own ordinary interaction state.
- Organize feature-specific UI under `src/features/`; keep reusable primitives under `src/components/ui` and shared data/API/hooks at the top-level `src` owners.
- React Compiler enabled. Avoid manual memoization unless measured need exists.
- Prefer low-color application chrome. Reserve semantic color for active, failed, queued, delivered, and connection states.
- Recent activity, call status, and steering status come from server snapshots/events.

## Global Invariants

- All browser paths live under `/ui/`; API lives under `/ui/api/`.
- UI availability follows server `ui.enabled`. Disabled server UI means no observer, API, SSE, or static dashboard.
- Initial agent state comes from HTTP snapshot; live changes come from SSE.
- Production build output is `ui/dist`; openchatx-mcp serves it directly.

## Route Next

- [Runtime and Interaction Map](./architecture.md)
