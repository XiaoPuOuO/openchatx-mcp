import { Check, ShieldAlert, X } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "../../components/ui/button"
import { useI18n } from "../../i18n"
import { decideSubagentApproval, fetchSubagentApprovals } from "../../lib/api"
import type { RuntimeApproval } from "../../lib/runtime-control-api"

export function SubagentApprovals({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const [approvals, setApprovals] = useState<RuntimeApproval[]>([])
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const items = await fetchSubagentApprovals(sessionId)
        if (active) setApprovals(items)
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [sessionId])

  async function decide(id: string, choice: "approve-once" | "allow-operation" | "deny") {
    setBusy(id)
    setError(undefined)
    try {
      await decideSubagentApproval(id, choice)
      setApprovals((current) => current.filter((item) => item.id !== id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  if (approvals.length === 0 && !error) return null
  return (
    <section
      className="shrink-0 border-t border-amber-500/30 bg-amber-500/5 px-4 py-3 sm:px-7"
      data-testid="subagent-approvals"
    >
      <div className="mx-auto max-h-56 w-full max-w-[780px] space-y-3 overflow-y-auto overscroll-contain">
        {approvals.map((approval) => (
          <div key={approval.id} className="space-y-2" data-testid="subagent-approval-request">
            <div className="flex items-center gap-2 text-xs font-medium">
              <ShieldAlert className="size-4 text-amber-500" />
              {t("subagents.approvalTitle")}
              <span className="truncate font-mono text-muted-foreground">{approval.toolName}</span>
            </div>
            <p className="text-xs text-muted-foreground">{approval.reason}</p>
            {approval.input !== undefined && (
              <pre className="max-h-24 overflow-auto rounded-md border border-border/60 bg-background/70 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
                {typeof approval.input === "string"
                  ? approval.input
                  : JSON.stringify(approval.input, null, 2)}
              </pre>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy === approval.id}
                onClick={() => void decide(approval.id, "approve-once")}
              >
                <Check className="size-3.5" /> {t("subagents.approvalOnce")}
              </Button>
              <Button
                size="sm"
                disabled={busy === approval.id}
                onClick={() => void decide(approval.id, "allow-operation")}
              >
                {t("subagents.approvalAllow")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === approval.id}
                onClick={() => void decide(approval.id, "deny")}
              >
                <X className="size-3.5" /> {t("subagents.approvalDeny")}
              </Button>
            </div>
          </div>
        ))}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <p className="text-[11px] text-muted-foreground">{t("subagents.approvalHint")}</p>
      </div>
    </section>
  )
}
