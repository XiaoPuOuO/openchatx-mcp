import { Activity, CircleAlert, CircleCheck, CircleOff } from "lucide-react"
import { useEffect, useState } from "react"

import { Badge } from "../../components/ui/badge"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import { fetchCapabilityHealth } from "../../lib/api"
import type { CapabilityHealthSnapshot, CapabilityHealthStatus } from "../../types"

export function CapabilityHealthPanel() {
  const { t } = useI18n()
  const [snapshot, setSnapshot] = useState<CapabilityHealthSnapshot>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const next = await fetchCapabilityHealth()
        if (!cancelled) {
          setSnapshot(next)
          setError(undefined)
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 10_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  if (error) {
    return (
      <Card className="mb-5 border-destructive/30">
        <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
      </Card>
    )
  }
  if (!snapshot) return null

  const unavailable = snapshot.components.filter((component) => component.status === "unavailable")
  return (
    <Card className="mb-5">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="size-4" />
          {t("status.capabilityHealth")}
          <Badge className={unavailable.length > 0 ? "text-destructive" : undefined}>
            {unavailable.length === 0
              ? t("status.healthy")
              : t("status.unavailableCount", { count: unavailable.length })}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {snapshot.components.map((component) => (
          <div key={component.id} className="rounded-md border px-3 py-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <HealthIcon status={component.status} />
              <span className="truncate">{localizeComponentName(component.name, t)}</span>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {localizeHealthDetail(component.detail, component.status, t)}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function localizeComponentName(
  name: string,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  const key = COMPONENT_NAME_KEYS[name]
  return key ? t(key) : name
}

function localizeHealthDetail(
  detail: string | undefined,
  status: CapabilityHealthStatus,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  if (!detail) return t(`status.health.${status}`)
  const tools = detail.match(/^(\d+) tools available$/)
  if (tools) return t("status.toolsAvailable", { count: Number(tools[1]) })
  const toolbox = detail.match(/^(\d+) tools, (\d+) skills$/)
  if (toolbox) {
    return t("status.toolsSkills", { tools: Number(toolbox[1]), skills: Number(toolbox[2]) })
  }
  const model = detail.match(/^(\d+) enabled model profile$/)
  if (model) return t("status.modelProfiles", { count: Number(model[1]) })
  if (detail === "profile openchatx") return t("status.profileOpenchatx")
  return detail
}

const COMPONENT_NAME_KEYS: Record<string, string> = {
  "OpenChatX Runtime": "status.component.runtime",
  "OpenAI Secure MCP Tunnel": "status.component.tunnel",
  Files: "status.component.files",
  "Durable Jobs": "status.component.durableJobs",
  "MCP Manager": "status.component.mcpManager",
  Media: "status.component.media",
  Nodes: "status.component.nodes",
  Projects: "status.component.projects",
  "Provider Hub": "status.component.providerHub",
  Search: "status.component.search",
  Shell: "status.component.shell",
  Skills: "status.component.skills",
  Rules: "status.component.rules",
  "Capability Store": "status.component.capabilityStore",
  Subagents: "status.component.subagents",
  System: "status.component.system",
  "Agent Teams": "status.component.agentTeams",
  "Toolbox Manager": "status.component.toolboxManager",
  Web: "status.component.web",
  "Capability Composer": "status.component.capabilityComposer",
}

function HealthIcon({ status }: { status: CapabilityHealthStatus }) {
  if (status === "healthy") return <CircleCheck className="size-4 text-emerald-600" />
  if (status === "disabled") return <CircleOff className="size-4 text-muted-foreground" />
  return <CircleAlert className="size-4 text-amber-600" />
}
