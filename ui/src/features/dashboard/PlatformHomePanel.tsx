import {
  AlertTriangle,
  Bot,
  Boxes,
  FolderKanban,
  GitBranch,
  Network,
  PackageOpen,
  Workflow,
} from "lucide-react"
import { useEffect, useState } from "react"

import { Badge } from "../../components/ui/badge"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { fetchPlatformOverview } from "../../lib/api"
import type { PlatformOverview } from "../../types"

export function PlatformHomePanel({ onOpenProjects }: { onOpenProjects: () => void }) {
  const [overview, setOverview] = useState<PlatformOverview>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const value = await fetchPlatformOverview()
        if (!cancelled) {
          setOverview(value)
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
  if (!overview) return null

  const metrics = [
    {
      label: "Capabilities",
      value: overview.counts.capabilities,
      icon: Boxes,
    },
    {
      label: "Projects",
      value: overview.counts.projects,
      icon: FolderKanban,
    },
    {
      label: "Model profiles",
      value: overview.counts.modelProfiles,
      icon: Bot,
    },
    {
      label: "Providers",
      value: overview.counts.providers,
      icon: GitBranch,
    },
    {
      label: "Agent teams",
      value: overview.counts.teams,
      icon: Network,
    },
    {
      label: "Workflows",
      value: overview.counts.workflows,
      icon: Workflow,
    },
    {
      label: "Nodes",
      value: overview.counts.nodes,
      icon: Network,
    },
    {
      label: "Store available",
      value: overview.counts.storeAvailable,
      icon: PackageOpen,
    },
  ]

  return (
    <div className="mb-5 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        {metrics.map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{label}</span>
                <Icon className="size-4 text-muted-foreground" />
              </div>
              <div className="mt-2 text-2xl font-semibold">{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="font-medium">Projects</div>
              <div className="flex items-center gap-2">
                <Badge>{overview.projects.length}</Badge>
                <Button variant="outline" size="sm" onClick={onOpenProjects}>
                  Manage
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview.projects.length === 0 ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Register an existing folder so ChatGPT sessions can use it as their default
                  context and permission scope.
                </p>
                <Button variant="outline" size="sm" onClick={onOpenProjects}>
                  Register Project
                </Button>
              </div>
            ) : (
              overview.projects.slice(0, 6).map((project) => (
                <div key={project.id} className="rounded-md border px-3 py-2">
                  <div className="text-sm font-medium">{project.name}</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{project.path}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge>{project.activeAgents} agents</Badge>
                    <Badge>{project.runningJobs} jobs</Badge>
                    {(["read", "write", "shell"] as const).map((permission) => (
                      <Badge key={permission}>
                        {permission}:{project.permissions[permission] ? "on" : "off"}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="font-medium">Current work</div>
              <Badge>{overview.currentWork.length}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview.currentWork.length === 0 ? (
              <p className="text-sm text-muted-foreground">No durable jobs are running.</p>
            ) : (
              overview.currentWork.map((job) => (
                <div key={job.id} className="rounded-md border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">{job.label}</div>
                    {job.projectId ? <Badge>{job.projectId}</Badge> : null}
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{job.cwd}</div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="font-medium">Needs attention</div>
              <Badge
                className={overview.needsAttention.length > 0 ? "text-destructive" : undefined}
              >
                {overview.needsAttention.length}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview.needsAttention.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing needs attention.</p>
            ) : (
              overview.needsAttention.map((item) => (
                <div key={`${item.source}:${item.id}`} className="rounded-md border px-3 py-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <AlertTriangle className="size-4 text-amber-600" />
                    {item.label}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{item.detail}</div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
