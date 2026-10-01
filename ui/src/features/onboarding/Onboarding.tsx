import { CheckCircle2, CircleAlert, PlugZap } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { type Diagnostics, fetchDiagnostics, updateRecoveryState } from "../../lib/api"

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [diagnostics, setDiagnostics] = useState<Diagnostics>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    void fetchDiagnostics()
      .then(setDiagnostics)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
  }, [])

  const blocking = diagnostics?.checks.some((check) => check.status === "error") ?? true

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/95 p-5 backdrop-blur">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <div className="flex items-center gap-2 text-lg font-semibold">
            <PlugZap className="size-5" />
            Set up OpenChatX
          </div>
          <p className="text-sm text-muted-foreground">
            Verify the local runtime, connect ChatGPT through the Secure MCP Tunnel, then run your
            first Agent task.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {diagnostics?.checks.map((check) => (
            <div key={check.id} className="flex gap-3 rounded-md border p-3">
              {check.status === "error" ? (
                <CircleAlert className="mt-0.5 size-4 text-destructive" />
              ) : (
                <CheckCircle2 className="mt-0.5 size-4" />
              )}
              <div>
                <div className="text-sm font-medium">{check.label}</div>
                <div className="text-xs text-muted-foreground">{check.detail}</div>
              </div>
            </div>
          ))}
          <div className="rounded-md border p-3 text-sm">
            <div className="font-medium">Next: connect ChatGPT</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Confirm your Tunnel is connected, then ask ChatGPT to call OpenChatX and create a
              temporary test file. You can remove it afterward.
            </div>
          </div>
          {error ? <div className="text-sm text-destructive">{error}</div> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => void fetchDiagnostics().then(setDiagnostics)}>
              Recheck
            </Button>
            <Button
              disabled={blocking}
              onClick={() =>
                void updateRecoveryState({ onboardingCompleted: true }).then(() => onComplete())
              }
            >
              Finish setup
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
