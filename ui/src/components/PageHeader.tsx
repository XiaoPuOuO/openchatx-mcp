import { ArrowLeft, type LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import { useI18n } from "../i18n"
import { Button } from "./ui/button"

export function PageHeader({
  icon: Icon,
  title,
  subtitle,
  onBack,
  actions,
}: {
  icon: LucideIcon
  title: string
  subtitle: string
  onBack?: () => void
  actions?: ReactNode
}) {
  const { t } = useI18n()

  return (
    <header className="page-header">
      <div className="page-header-inner">
        <div className="page-header-leading">
          {onBack ? (
            <>
              <Button variant="ghost" size="sm" className="page-header-back" onClick={onBack}>
                <ArrowLeft className="size-4" />
                {t("common.back")}
              </Button>
              <div className="page-header-separator" />
            </>
          ) : null}
          <div className="page-header-icon">
            <Icon className="size-4" />
          </div>
          <div className="min-w-0">
            <h1 className="page-header-title">{title}</h1>
            <p className="page-header-subtitle">{subtitle}</p>
          </div>
        </div>
        {actions ? <div className="page-header-actions">{actions}</div> : null}
      </div>
    </header>
  )
}
