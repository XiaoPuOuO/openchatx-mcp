import { Check, Circle, Clock3, LoaderCircle, Send, Terminal, TriangleAlert, Wrench } from "lucide-react"
import { useMemo, useState } from "react"

import { steerAgent } from "../lib/api"
import type { Agent, AgentCall } from "../types"
import { Badge } from "./ui/badge"
import { Button } from "./ui/button"
import { Card, CardContent, CardHeader } from "./ui/card"
import { Textarea } from "./ui/textarea"

export function AgentCard({ agent, now }: { agent: Agent; now: number }) {
  const [message, setMessage] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const pending = agent.instructions.filter((instruction) => !instruction.deliveredAt)
  const latestDelivered = agent.instructions.find((instruction) => instruction.deliveredAt)
  const activeFor = agent.current ? formatDuration(now - agent.current.startedAt) : undefined
  const idleFor = formatDuration(Math.max(0, now - agent.lastSeenAt))

  const recent = useMemo(() => agent.recent.slice(0, 4), [agent.recent])

  async function submitSteer() {
    const trimmed = message.trim()
    if (!trimmed || sending) return
    setSending(true)
    setError(undefined)
    try {
      await steerAgent(agent.id, trimmed)
      setMessage("")
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError))
    } finally {
      setSending(false)
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b bg-card/70">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusDot active={Boolean(agent.current)} />
              <h2 className="truncate text-base font-semibold tracking-tight">{agent.id}</h2>
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">{agent.taskSlug ?? "No task name yet"}</p>
          </div>
          <Badge className={agent.current ? "text-foreground" : undefined}>{agent.current ? `ACTIVE · ${activeFor}` : `IDLE · ${idleFor}`}</Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-5 pt-5">
        <CurrentActivity call={agent.current} now={now} />

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent</h3>
            <span className="text-xs text-muted-foreground">{agent.recent.length} retained</span>
          </div>
          <div className="space-y-1">
            {recent.length ? recent.map((call) => <ActivityRow key={call.id} call={call} />) : <EmptyRecent />}
          </div>
        </div>

        <div className="space-y-2 border-t pt-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Steer</h3>
            {pending.length > 0 ? (
              <Badge className="border-amber-200 bg-amber-50 text-amber-700">QUEUED · {pending.length}</Badge>
            ) : latestDelivered ? (
              <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">LAST DELIVERED</Badge>
            ) : null}
          </div>
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submitSteer()
            }}
            placeholder="Send an instruction on this agent's current or next tool response..."
          />
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 text-xs text-muted-foreground">
              {error ? <span className="text-destructive">{error}</span> : pending[0] ? <span className="truncate">Queued: {pending[0].message}</span> : latestDelivered ? <span className="truncate">Delivered: {latestDelivered.message}</span> : "⌘ Enter to send"}
            </div>
            <Button size="sm" disabled={!message.trim() || sending} onClick={() => void submitSteer()}>
              {sending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
              Send
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function CurrentActivity({ call, now }: { call?: AgentCall; now: number }) {
  if (!call) {
    return (
      <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed bg-muted/30 px-4 text-sm text-muted-foreground">
        Waiting for the next Shellby tool call
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <ToolIcon tool={call.tool} />
          <span className="truncate text-sm font-semibold uppercase tracking-wide">{call.tool}</span>
        </div>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatDuration(now - call.startedAt)}</span>
      </div>
      <p className="mt-3 break-words font-mono text-sm leading-6">{call.summary || "Working..."}</p>
    </div>
  )
}

function ActivityRow({ call }: { call: AgentCall }) {
  return (
    <div className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs ${call.status === "failed" ? "bg-red-50 text-red-700" : "hover:bg-muted/60"}`}>
      {call.status === "failed" ? <TriangleAlert className="size-3.5 shrink-0 text-red-600" /> : <Check className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className="w-24 shrink-0 truncate font-medium">{call.tool}</span>
      <span className={`min-w-0 flex-1 truncate font-mono ${call.status === "failed" ? "text-red-700" : "text-muted-foreground"}`}>{call.summary || "Completed"}</span>
      <span className={call.status === "failed" ? "shrink-0 text-red-600" : "shrink-0 text-muted-foreground"}>{formatClock(call.finishedAt ?? call.startedAt)}</span>
    </div>
  )
}

function EmptyRecent() {
  return <div className="rounded-md px-2 py-4 text-center text-xs text-muted-foreground">No completed activity yet</div>
}

function StatusDot({ active }: { active: boolean }) {
  return active ? <span className="size-2.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.12)]" /> : <Circle className="size-2.5 fill-neutral-300 text-neutral-300" />
}

function ToolIcon({ tool }: { tool: string }) {
  if (tool.startsWith("shell_")) return <Terminal className="size-4 text-muted-foreground" />
  if (tool === "apply_patch") return <Wrench className="size-4 text-muted-foreground" />
  return <Clock3 className="size-4 text-muted-foreground" />
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}
