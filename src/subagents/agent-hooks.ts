import type { AgentFunctionCall } from "./agent-provider.js"

export type SubagentLifecycleEvent =
  | { type: "beforeTool"; sessionId: string; jobId: string; call: AgentFunctionCall }
  | {
      type: "afterTool"
      sessionId: string
      jobId: string
      call: AgentFunctionCall
      failed: boolean
      output: string
    }
  | { type: "onError"; sessionId: string; jobId: string; error: string }
  | { type: "onComplete"; sessionId: string; jobId: string; content: string }

/**
 * Extension boundary for dashboards and plugins. A beforeTool hook may throw
 * to veto a call; post-event hooks are isolated so a faulty observer cannot
 * incorrectly mark successfully executed side effects as failed.
 */
export class SubagentHookRegistry {
  private readonly listeners = new Set<(event: SubagentLifecycleEvent) => void | Promise<void>>()

  register(listener: (event: SubagentLifecycleEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async emit(event: SubagentLifecycleEvent): Promise<void> {
    for (const listener of this.listeners) {
      if (event.type === "beforeTool") await listener(event)
      else {
        try {
          await listener(event)
        } catch (error) {
          console.warn(
            `Subagent lifecycle observer failed (${event.type}): ${error instanceof Error ? error.message : JSON.stringify(error)}`
          )
        }
      }
    }
  }
}
