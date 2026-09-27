import type { PlatformOverview } from "../types"

type AttentionItem = PlatformOverview["needsAttention"][number]

const STORAGE_KEY = "openchatx.dismissed-attention"

function signature(item: AttentionItem): string {
  return JSON.stringify([item.source, item.id, item.detail])
}

function readDismissed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((value): value is string => typeof value === "string"))
  } catch {
    return new Set()
  }
}

function writeDismissed(values: Set<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...values]))
  } catch {
    // Dismissal is a UI convenience; storage failures should not break status rendering.
  }
}

export function dismissAttentionItem(item: AttentionItem): void {
  const dismissed = readDismissed()
  dismissed.add(signature(item))
  writeDismissed(dismissed)
}

export function isAttentionItemDismissed(item: AttentionItem): boolean {
  return readDismissed().has(signature(item))
}

export function visibleAttentionItems(items: AttentionItem[]): AttentionItem[] {
  const dismissed = readDismissed()
  return items.filter((item) => !dismissed.has(signature(item)))
}
