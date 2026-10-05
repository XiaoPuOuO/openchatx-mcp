import { Cloud, LoaderCircle, Square } from "lucide-react"
import { useState } from "react"

import { PageHeader } from "../../components/PageHeader"
import { Button } from "../../components/ui/button"
import { Card, CardContent } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import { stopAgentCall } from "../../lib/api"
import type { Agent } from "../../types"

export function DotPage({
  agents,
  now,
  onBack,
}: {
  agents: Agent[]
  now: number
  onBack: () => void
}) {
  const { t } = useI18n()
  const [stoppingAgentId, setStoppingAgentId] = useState<string>()

  const dotAgents = agents.filter((agent) => agent.dot)
  const activeAgents = dotAgents.filter((agent) => now - agent.lastSeenAt < 30_000)

  async function stopCurrent(agent: Agent) {
    if (!agent.current) return
    setStoppingAgentId(agent.id)
    try {
      await stopAgentCall(agent.id, agent.current.id)
    } catch {
      // The next agents refresh reflects the real state.
    } finally {
      setStoppingAgentId(undefined)
    }
  }

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
              {dotAgents.map((agent) => {
                const active = now - agent.lastSeenAt < 30_000
                return (
                  <Card key={agent.id} className="overflow-hidden">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className={active ? "status-dot status-dot-online" : "status-dot"}
                            />
                            <h3 className="truncate text-sm font-semibold">{agent.id}</h3>
                            <span
                              className={
                                active ? "session-state session-state-active" : "session-state"
                              }
                            >
                              {active ? t("agent.active") : t("agent.inactive")}
                            </span>
                          </div>
                          <p className="mt-2 truncate text-xs text-muted-foreground">
                            {agent.taskSlug ?? t("agent.noTask")}
                          </p>
                          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                            <span>
                              {t("agent.recent")}: {agent.recent.length}
                            </span>
                            {agent.contextBudget ? (
                              <span>{agent.contextBudget.tokens.toLocaleString()} tokens</span>
                            ) : null}
                          </div>
                        </div>
                        {agent.current ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={stoppingAgentId === agent.id}
                            title={t("agent.stopCall")}
                            onClick={() => void stopCurrent(agent)}
                          >
                            {stoppingAgentId === agent.id ? (
                              <LoaderCircle className="size-3.5 animate-spin" />
                            ) : (
                              <Square className="size-3.5" />
                            )}
                            <span className="max-w-40 truncate">{agent.current.tool}</span>
                          </Button>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
