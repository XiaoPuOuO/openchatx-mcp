import type { CapabilityRegistry } from "../capabilities/catalog.js"
import type { CapabilityHealthService } from "../capabilities/health.js"
import type { JobManager } from "../jobs/job-manager.js"
import type { NodeRegistry } from "../nodes/node-registry.js"
import type { ProjectRegistry } from "../projects/project-registry.js"
import type { CapabilityStoreService } from "../store/store-service.js"
import type { SubagentRuntime } from "../subagents/runtime.js"
import type { AgentTeamService } from "../teams/team-service.js"
import type { WorkflowService } from "../workflows/workflow-service.js"

export interface PlatformOverview {
  counts: {
    capabilities: number
    projects: number
    providers: number
    modelProfiles: number
    teams: number
    workflows: number
    nodes: number
    storeAvailable: number
  }
  projects: Array<{
    id: string
    name: string
    path: string
    permissions: { read: boolean; write: boolean; shell: boolean }
  }>
  currentWork: Array<{
    id: string
    label: string
    status: string
    cwd: string
    updatedAt: string
  }>
  needsAttention: Array<{
    id: string
    source: "health" | "job"
    label: string
    detail: string
  }>
}

export interface PlatformOverviewServices {
  capabilities?: CapabilityRegistry
  health?: CapabilityHealthService
  jobs?: JobManager
  projects?: ProjectRegistry
  store?: CapabilityStoreService
  subagents?: SubagentRuntime
  teams?: AgentTeamService
  workflows?: WorkflowService
  nodes?: NodeRegistry
}

export class PlatformOverviewService {
  constructor(private readonly services: PlatformOverviewServices) {}

  async snapshot(): Promise<PlatformOverview> {
    const [projects, jobs, health, store, teams, workflows, nodes] = await Promise.all([
      this.services.projects?.list() ?? [],
      this.services.jobs?.list() ?? [],
      this.services.health?.snapshot(),
      this.services.store?.list() ?? [],
      this.services.teams?.list() ?? [],
      this.services.workflows?.list() ?? [],
      this.services.nodes?.list() ?? [],
    ])
    const capabilities = this.services.capabilities?.list() ?? []
    const providers = this.services.subagents?.providerSummaries() ?? []
    const profiles = this.services.subagents?.profiles() ?? []

    const needsAttention: PlatformOverview["needsAttention"] = []
    for (const component of health?.components ?? []) {
      if (component.status !== "unavailable" && component.status !== "degraded") continue
      needsAttention.push({
        id: component.id,
        source: "health",
        label: component.name,
        detail: component.detail ?? component.status,
      })
    }
    for (const job of jobs) {
      if (job.status !== "failed") continue
      needsAttention.push({
        id: job.id,
        source: "job",
        label: job.label,
        detail: `Job failed in ${job.cwd}`,
      })
    }

    return {
      counts: {
        capabilities: capabilities.length,
        projects: projects.length,
        providers: providers.filter((provider) => provider.enabled).length,
        modelProfiles: profiles.length,
        teams: teams.length,
        workflows: workflows.length,
        nodes: nodes.filter((node) => node.enabled).length,
        storeAvailable: store.filter((entry) => !entry.installed).length,
      },
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        path: project.path,
        permissions: project.permissions,
      })),
      currentWork: jobs
        .filter((job) => job.status === "running")
        .slice(0, 8)
        .map((job) => ({
          id: job.id,
          label: job.label,
          status: job.status,
          cwd: job.cwd,
          updatedAt: job.updatedAt,
        })),
      needsAttention: needsAttention.slice(0, 12),
    }
  }
}
