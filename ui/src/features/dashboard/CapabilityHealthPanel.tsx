import { Activity, CircleAlert, CircleCheck, CircleOff } from "lucide-react"
import { useEffect, useState } from "react"

import { Badge } from "../../components/ui/badge"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { fetchCapabilityHealth } from "../../lib/api"
import type { CapabilityHealthSnapshot, CapabilityHealthStatus } from "../../types"

export function CapabilityHealthPanel() {
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
          Capability health
          <Badge className={unavailable.length > 0 ? "text-destructive" : undefined}>
            {unavailable.length === 0 ? "Healthy" : `${unavailable.length} unavailable`}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {snapshot.components.map((component) => (
          <div key={component.id} className="rounded-md border px-3 py-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <HealthIcon status={component.status} />
              <span className="truncate">{component.name}</span>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {component.detail ?? component.status}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function HealthIcon({ status }: { status: CapabilityHealthStatus }) {
  if (status === "healthy") return <CircleCheck className="size-4 text-emerald-600" />
  if (status === "disabled") return <CircleOff className="size-4 text-muted-foreground" />
  return <CircleAlert className="size-4 text-amber-600" />
}
