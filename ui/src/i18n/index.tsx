import { createContext, useContext, useEffect, useMemo, useState } from "react"

import { en } from "./locales/en"
import { ja } from "./locales/ja"
import { zhTW } from "./locales/zh-TW"
import type { Locale, Messages, TranslationValues } from "./types"

const STORAGE_KEY = "openchatx-mcp.locale"

const localeMessages: Record<Locale, Messages> = {
  en,
  "zh-TW": zhTW,
  ja,
}

const localeLabels: Record<Locale, string> = {
  en: "English",
  "zh-TW": "繁體中文",
  ja: "日本語",
}

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string, values?: TranslationValues) => string
  locales: readonly Locale[]
  localeLabels: Record<Locale, string>
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined)

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>(detectLocale)

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, locale)
    document.documentElement.lang = locale
  }, [locale])

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      locales: ["zh-TW", "en", "ja"],
      localeLabels,
      t: (key, values) => interpolate(localeMessages[locale][key] ?? en[key] ?? key, values),
    }),
    [locale]
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)
  if (!context) throw new Error("useI18n must be used inside I18nProvider")
  return context
}

function detectLocale(): Locale {
  const saved = window.localStorage.getItem(STORAGE_KEY)
  if (saved === "en" || saved === "zh-TW" || saved === "ja") return saved
  const browser = navigator.language.toLowerCase()
  if (browser.startsWith("ja")) return "ja"
  if (browser.startsWith("zh")) return "zh-TW"
  return "en"
}

function interpolate(template: string, values?: TranslationValues): string {
  if (!values) return template
  return template.replace(/\{([^}]+)\}/gu, (match, key: string) => {
    const value = values[key]
    return value === undefined ? match : String(value)
  })
}
