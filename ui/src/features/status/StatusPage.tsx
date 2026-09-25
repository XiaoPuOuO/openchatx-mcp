import { Activity, ArrowLeft } from "lucide-react"

import { Button } from "../../components/ui/button"
import { useI18n } from "../../i18n"
import { CapabilityHealthPanel } from "../dashboard/CapabilityHealthPanel"

export function StatusPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  return (
    <main className="min-h-screen">
      <header className="border-b bg-background/95">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-4">
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
            {t("common.back")}
          </Button>
          <Activity className="size-5" />
          <div>
            <h1 className="font-semibold">{t("status.title")}</h1>
            <p className="text-xs text-muted-foreground">{t("status.subtitle")}</p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-6">
        <CapabilityHealthPanel />
      </div>
    </main>
  )
}
