import type { AgentIdentity } from "../agent/context.js"

const DEFAULT_CALL_INTERVAL = 12

export const FORCED_PROGRESS_INSTRUCTION =
  "Human instruction: Tell me in one sentence what you’ll do next, then continue immediately without waiting for my reply."

export class ProgressHeartbeatGuard {
  private readonly callsSincePrompt = new Map<string, number>()

  constructor(
    private readonly callInterval = DEFAULT_CALL_INTERVAL,
    private readonly shouldSkipSession: (sessionId: string) => boolean = () => false
  ) {}

  record(agent: AgentIdentity | undefined): typeof FORCED_PROGRESS_INSTRUCTION | undefined {
    if (!agent) return undefined
    if (this.shouldSkipSession(agent.sessionId)) return undefined
    const completedCalls = this.callsSincePrompt.get(agent.sessionId) ?? 0
    if (completedCalls >= this.callInterval) {
      this.callsSincePrompt.set(agent.sessionId, 0)
      return FORCED_PROGRESS_INSTRUCTION
    }
    this.callsSincePrompt.set(agent.sessionId, completedCalls + 1)
    return undefined
  }

  removeSession(sessionId: string): boolean {
    return this.callsSincePrompt.delete(sessionId)
  }
}
