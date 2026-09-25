import type { ProjectScope } from "../projects/project-scope.js"
import type { GoalRegistry, GoalStatus, RegisteredGoal } from "./goal-registry.js"

const TERMINAL_STATUSES = new Set(["completed", "cancelled"])

export class GoalScope {
  constructor(
    private readonly goals: GoalRegistry,
    private readonly projects?: ProjectScope
  ) {}

  async list(status?: GoalStatus): Promise<RegisteredGoal[]> {
    const projectId = (await this.projects?.current())?.id
    return this.goals.list({ projectId: projectId ?? null, status })
  }

  async open(): Promise<RegisteredGoal[]> {
    return (await this.list()).filter((goal) => !TERMINAL_STATUSES.has(goal.status))
  }

  async get(goalId: string): Promise<RegisteredGoal> {
    const goal = await this.goals.get(goalId)
    const projectId = (await this.projects?.current())?.id
    if (goal.projectId !== projectId) {
      throw new Error(
        projectId
          ? `Goal ${JSON.stringify(goal.id)} does not belong to active Project ${JSON.stringify(projectId)}.`
          : `Goal ${JSON.stringify(goal.id)} belongs to a Project and is not available in an unscoped session.`
      )
    }
    return goal
  }

  async create(input: {
    id: string
    title: string
    description?: string
  }): Promise<RegisteredGoal> {
    const projectId = (await this.projects?.current())?.id
    return this.goals.upsert({
      ...input,
      projectId,
    })
  }
}
