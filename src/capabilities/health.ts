import { MCP_CONFIG } from "../config.js"
import type { ExternalMcpRegistry } from "../external-mcp/registry.js"
import type { SubagentRuntime } from "../subagents/runtime.js"
import type { ToolboxRegistry } from "../toolbox/registry.js"

export type CapabilityHealthStatus =
  | "healthy"
  | "starting"
  | "degraded"
  | "unavailable"
  | "disabled"

export interface CapabilityHealthComponent {
  id: string
  kind: "runtime" | "tunnel" | "mcp" | "toolbox" | "provider"
  name: string
  status: CapabilityHealthStatus
  detail?: string
}

export interface CapabilityHealthSnapshot {
  status: "healthy" | "degraded"
  checkedAt: string
  components: CapabilityHealthComponent[]
}

const TUNNEL_STARTUP_GRACE_MS = 15_000

export class CapabilityHealthService {
  private readonly startedAt = Date.now()

  constructor(
    private readonly externalMcp?: ExternalMcpRegistry,
    private readonly toolboxes?: ToolboxRegistry,
    private readonly subagents?: SubagentRuntime
  ) {}

  async snapshot(): Promise<CapabilityHealthSnapshot> {
    const components: CapabilityHealthComponent[] = [
      {
        id: "openchatx",
        kind: "runtime",
        name: "OpenChatX Runtime",
        status: "healthy",
      },
      await tunnelHealth(Date.now() - this.startedAt < TUNNEL_STARTUP_GRACE_MS),
      ...this.mcpComponents(),
      ...this.toolboxComponents(),
      ...this.providerComponents(),
    ]
    return {
      status: components.some((component) => component.status === "unavailable")
        ? "degraded"
        : "healthy",
      checkedAt: new Date().toISOString(),
      components,
    }
  }

  private mcpComponents(): CapabilityHealthComponent[] {
    return (
      this.externalMcp?.capabilities().map((capability) => ({
        id: `mcp:${capability.id}`,
        kind: "mcp" as const,
        name: capability.name,
        status: capability.available ? ("healthy" as const) : ("unavailable" as const),
        detail: capability.available
          ? `${capability.toolCount} tools available`
          : "Configured but unavailable",
      })) ?? []
    )
  }

  private toolboxComponents(): CapabilityHealthComponent[] {
    return (
      this.toolboxes?.snapshots().map((toolbox) => {
        const errors = [...toolbox.tools, ...toolbox.skills].filter((item) => item.error)
        let status: CapabilityHealthStatus = "healthy"
        if (!toolbox.enabled) status = "disabled"
        else if (errors.length > 0) status = "degraded"
        return {
          id: `toolbox:${toolbox.id}`,
          kind: "toolbox" as const,
          name: toolbox.name,
          status,
          detail:
            errors.length > 0
              ? `${errors.length} item${errors.length === 1 ? "" : "s"} failed to load`
              : `${toolbox.tools.filter((item) => item.enabled).length} tools, ${toolbox.skills.filter((item) => item.enabled).length} skills`,
        }
      }) ?? []
    )
  }

  private providerComponents(): CapabilityHealthComponent[] {
    return (
      this.subagents?.providerSummaries().map((provider) => ({
        id: `provider:${provider.id}`,
        kind: "provider" as const,
        name: provider.id,
        status: provider.enabled ? ("healthy" as const) : ("disabled" as const),
        detail: provider.enabled
          ? `${provider.profileCount} enabled model profile${provider.profileCount === 1 ? "" : "s"}`
          : "Provider disabled",
      })) ?? []
    )
  }
}

async function tunnelHealth(starting: boolean): Promise<CapabilityHealthComponent> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  try {
    const response = await fetch(
      `http://127.0.0.1:${MCP_CONFIG.tunnel.healthPort}/health?details=true`,
      { signal: controller.signal }
    )
    const payload = response.ok ? await response.json().catch(() => undefined) : undefined
    const operational = isTunnelOperational(payload)
    return {
      id: "tunnel",
      kind: "tunnel",
      name: "OpenAI Secure MCP Tunnel",
      status: tunnelHealthStatus(operational, starting),
      ...tunnelHealthDetail(operational, starting, response.status, response.ok),
    }
  } catch (error) {
    return {
      id: "tunnel",
      kind: "tunnel",
      name: "OpenAI Secure MCP Tunnel",
      status: starting ? "starting" : "unavailable",
      ...(starting
        ? {}
        : { detail: error instanceof Error ? error.message : "Tunnel health check failed" }),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function tunnelHealthStatus(
  operational: boolean,
  starting: boolean
): "healthy" | "starting" | "unavailable" {
  if (operational) return "healthy"
  if (starting) return "starting"
  return "unavailable"
}

function tunnelHealthDetail(
  operational: boolean,
  starting: boolean,
  status: number,
  responseOk: boolean
): Pick<CapabilityHealthComponent, "detail"> {
  if (operational) {
    return { detail: `profile ${MCP_CONFIG.tunnel.profile} · control plane connected` }
  }
  if (starting) return {}
  return { detail: responseOk ? "Tunnel control plane is not connected" : `HTTP ${status}` }
}

export function isTunnelOperational(value: unknown): boolean {
  const health = asRecord(value)
  if (health?.live !== true) return false
  const components = asRecord(health.components)
  const controlPlane = components ? asRecord(components["control-plane"]) : undefined
  return controlPlane?.status === "ok"
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}
