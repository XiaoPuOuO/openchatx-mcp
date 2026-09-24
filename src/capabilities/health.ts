import { MCP_CONFIG } from "../config.js"
import type { ExternalMcpRegistry } from "../external-mcp/registry.js"
import type { SubagentRuntime } from "../subagents/runtime.js"
import type { ToolboxRegistry } from "../toolbox/registry.js"

export type CapabilityHealthStatus = "healthy" | "degraded" | "unavailable" | "disabled"

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

export class CapabilityHealthService {
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
      await tunnelHealth(),
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

async function tunnelHealth(): Promise<CapabilityHealthComponent> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  try {
    const response = await fetch(`http://127.0.0.1:${MCP_CONFIG.tunnel.healthPort}/readyz`, {
      signal: controller.signal,
    })
    return {
      id: "tunnel",
      kind: "tunnel",
      name: "OpenAI Secure MCP Tunnel",
      status: response.ok ? "healthy" : "unavailable",
      detail: response.ok ? `profile ${MCP_CONFIG.tunnel.profile}` : `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      id: "tunnel",
      kind: "tunnel",
      name: "OpenAI Secure MCP Tunnel",
      status: "unavailable",
      detail: error instanceof Error ? error.message : "Tunnel health check failed",
    }
  } finally {
    clearTimeout(timeout)
  }
}
