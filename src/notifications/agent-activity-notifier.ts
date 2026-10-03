import { desktopNotificationService } from "./notification-service.js"

class AgentActivityNotifier {
  private readonly timers = new Map<string, NodeJS.Timeout>()

  activityStarted(sessionId: string): void {
    const timer = this.timers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.timers.delete(sessionId)
  }

  activitySettled(sessionId: string, label?: string): void {
    this.activityStarted(sessionId)
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      void desktopNotificationService
        .notify("agentCompleted", "OpenChatX Agent activity completed", label ?? "Agent is idle.")
        .catch(() => undefined)
    }, 1_500)
    timer.unref()
    this.timers.set(sessionId, timer)
  }
}

export const agentActivityNotifier = new AgentActivityNotifier()
