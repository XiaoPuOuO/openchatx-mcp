import { Languages } from "lucide-react"

import { useI18n } from "../i18n"

export function LanguageSwitcher() {
  const { locale, setLocale, locales, localeLabels, t } = useI18n()
  return (
    <label className="flex h-9 items-center gap-2 rounded-md border bg-background px-2 text-xs text-muted-foreground">
      <Languages className="size-3.5" />
      <select
        className="bg-transparent text-xs text-foreground outline-none"
        value={locale}
        onChange={(event) => setLocale(event.target.value as typeof locale)}
        aria-label={t("common.language")}
      >
        {locales.map((item) => (
          <option key={item} value={item}>
            {localeLabels[item]}
          </option>
        ))}
      </select>
    </label>
  )
}
