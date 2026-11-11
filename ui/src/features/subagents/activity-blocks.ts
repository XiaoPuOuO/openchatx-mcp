import type { SubagentSessionEvent } from "../../types.js"

export type ActivityBlock =
  | { kind: "message"; id: string; event: SubagentSessionEvent }
  | { kind: "actions"; id: string; events: SubagentSessionEvent[] }

/**
 * A model can emit an assistant or reasoning event before every tool call.
 * Treat all work between human turns as one action group, without hiding
 * model commentary or changing the order of events when expanded.
 *
 * The final assistant reply (after the last tool) stays visible outside
 * the collapsed group.
 */
export function groupActivity(events: SubagentSessionEvent[]): ActivityBlock[] {
  const result: ActivityBlock[] = []
  let phase: SubagentSessionEvent[] = []

  const flush = () => {
    const first = phase[0]
    if (!first) return
    let lastToolIndex = -1
    for (let i = phase.length - 1; i >= 0; i--) {
      if (phase[i]?.role === "tool") {
        lastToolIndex = i
        break
      }
    }
    if (lastToolIndex >= 0) {
      result.push({
        kind: "actions",
        id: first.id,
        events: phase.slice(0, lastToolIndex + 1),
      })
    }
    for (const event of phase.slice(lastToolIndex + 1)) {
      result.push({ kind: "message", id: event.id, event })
    }
    phase = []
  }

  for (const event of events) {
    if (event.role === "user" || event.role === "guidance" || event.role === "harness") {
      flush()
      result.push({ kind: "message", id: event.id, event })
    } else {
      phase.push(event)
    }
  }
  flush()
  return result
}
