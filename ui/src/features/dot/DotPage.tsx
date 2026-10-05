import { Cloud } from "lucide-react"

import { PageHeader } from "../../components/PageHeader"
import { Card, CardContent } from "../../components/ui/card"
import { AgentCard } from "../dashboard/AgentCard"
import { useI18n } from "../../i18n"
import type { Agent } from "../../types"

export function DotPage({
  agents,
  now,
  onBack,
  onRemoveAgent,
}: {
  agents: Agent[]
  now: number
  onBack: () => void
  onRemoveAgent: (agentId: string) => Promise<void>
}) {
  const { t } = useI18n()

  const dotAgents = agents.filter((agent) => agent.dot)
  const activeAgents = dotAgents.filter((agent) => now - agent.lastSeenAt < 30_000)

  return (
    <main className="min-h-screen bg-muted/20">
      <PageHeader
        icon={Cloud}
        title={t("dot.title")}
        subtitle={t("dot.subtitle")}
        onBack={onBack}
      />

      <div className="mx-auto max-w-[1400px] px-5 py-6 lg:px-8">
        <section>
          <div className="mb-2.5 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold">{t("dot.sessions")}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("dot.sessionsSummary", {
                  active: activeAgents.length,
                  total: dotAgents.length,
                })}
              </p>
            </div>
          </div>

          {dotAgents.length === 0 ? (
            <Card>
              <CardContent className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
                <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border bg-muted/30">
                  <Cloud className="size-5 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium">{t("dot.noSessions")}</p>
                <p className="mt-1.5 max-w-md text-xs leading-5 text-muted-foreground">
                  {t("dot.noSessionsHint")}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {dotAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  now={now}
                  onDelete={() => onRemoveAgent(agent.id)}
                  showContextLimit={false}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
