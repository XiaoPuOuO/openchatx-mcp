import type { Agent, AgentChangedEvent, AgentInstruction } from "../types"

export async function fetchAgents(): Promise<Agent[]> {
  const response = await fetch("/ui/api/agents")
  if (!response.ok) throw new Error(`Failed to load agents (${response.status})`)
  const body = (await response.json()) as { agents?: Agent[] }
  return body.agents ?? []
}

export function subscribeToAgents(
  onEvent: (event: AgentChangedEvent) => void,
  onConnection: (connected: boolean) => void
): () => void {
  const source = new EventSource("/ui/api/events")
  source.onopen = () => onConnection(true)
  source.onerror = () => onConnection(false)
  source.onmessage = (message) => {
    const event = JSON.parse(message.data) as AgentChangedEvent
    if (event.type === "agent_changed") onEvent(event)
  }
  return () => source.close()
}

export async function steerAgent(agentId: string, message: string): Promise<AgentInstruction> {
  const response = await fetch(`/ui/api/agents/${encodeURIComponent(agentId)}/steer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Failed to steer agent (${response.status})`)
  }
  const body = (await response.json()) as { instruction: AgentInstruction }
  return body.instruction
}

export async function cancelSteer(agentId: string, instructionId: string): Promise<void> {
  const response = await fetch(
    `/ui/api/agents/${encodeURIComponent(agentId)}/instructions/${encodeURIComponent(instructionId)}`,
    { method: "DELETE" }
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Failed to cancel steer (${response.status})`)
  }
}
