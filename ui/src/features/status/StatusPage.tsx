import { Activity, ArrowLeft } from "lucide-react"

import { Button } from "../../components/ui/button"
import { CapabilityHealthPanel } from "../dashboard/CapabilityHealthPanel"

export function StatusPage({ onBack }: { onBack: () => void }) {
  return (
    <main className="min-h-screen">
      <header className="border-b bg-background/95">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-4">
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <Activity className="size-5" />
          <div>
            <h1 className="font-semibold">System status</h1>
            <p className="text-xs text-muted-foreground">
              Detailed runtime, tunnel, MCP, Toolbox, and Provider health.
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-6">
        <CapabilityHealthPanel />
      </div>
    </main>
  )
}
