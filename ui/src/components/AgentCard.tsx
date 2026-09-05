import { Check, Circle, LoaderCircle, TriangleAlert } from "lucide-react"
import { useState } from "react"

import type { Agent, AgentCall } from "../types"
import { AgentRoom } from "./AgentRoom"
import { SteerComposer } from "./SteerComposer"
import { ToolCallModal } from "./ToolCallModal"
import { Badge } from "./ui/badge"
import { Card, CardContent, CardHeader } from "./ui/card"

export function AgentCard({ agent, now }: { agent: Agent; now: number }) {
  const [selectedCall, setSelectedCall] = useState<AgentCall>()
  const active = now - agent.lastSeenAt < 30_000
  const recent = [agent.current, ...agent.recent].filter((call): call is AgentCall => Boolean(call))

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b bg-card/70">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusDot active={active} />
              <h2 className="truncate text-base font-semibold tracking-tight">{agent.id}</h2>
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">{agent.taskSlug ?? "No task name yet"}</p>
          </div>
          <Badge className={active ? "border-emerald-200 bg-emerald-50 text-emerald-700" : undefined}>{active ? "ACTIVE" : "INACTIVE"}</Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        <AgentRoom agent={agent} />

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent</h3>
          <div className="max-h-32 space-y-1 overflow-y-auto pr-1">
            {recent.map((call) => (
              <ActivityRow key={call.id} call={call} onClick={() => setSelectedCall(call)} />
            ))}
          </div>
        </div>

        <SteerComposer agent={agent} />
      </CardContent>
      <ToolCallModal call={selectedCall} onClose={() => setSelectedCall(undefined)} />
    </Card>
  )
}

function ActivityRow({ call, onClick }: { call: AgentCall; onClick: () => void }) {
  const running = call.status === "running"
  const failed = call.status === "failed"
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${failed ? "bg-red-50 text-red-700 hover:bg-red-100/70" : running ? "bg-emerald-50/60 hover:bg-emerald-50" : "hover:bg-muted/60"}`}
    >
      {failed ? (
        <TriangleAlert className="size-3.5 shrink-0 text-red-600" />
      ) : running ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-emerald-600" />
      ) : (
        <Check className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="w-24 shrink-0 truncate font-medium">{call.tool}</span>
      <span className={`min-w-0 flex-1 truncate font-mono ${failed ? "text-red-700" : "text-muted-foreground"}`}>
        {call.summary || (running ? "Working..." : "Completed")}
      </span>
      <span className={failed ? "shrink-0 text-red-600" : running ? "shrink-0 text-emerald-600" : "shrink-0 text-muted-foreground"}>
        {running ? "now" : formatClock(call.finishedAt ?? call.startedAt)}
      </span>
    </button>
  )
}

function StatusDot({ active }: { active: boolean }) {
  return active ? (
    <span className="size-2.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.12)]" />
  ) : (
    <Circle className="size-2.5 fill-neutral-300 text-neutral-300" />
  )
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}
