import { ArrowLeft, Download, PackageOpen, Trash2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import { Badge } from "../../components/ui/badge"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { fetchStoreEntries, installStoreEntry, uninstallStoreEntry } from "../../lib/api"
import type { CapabilityStoreEntry } from "../../types"

export function CapabilityStoreManager({ onBack }: { onBack: () => void }) {
  const [entries, setEntries] = useState<CapabilityStoreEntry[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()

  const load = useCallback(async () => {
    try {
      setEntries(await fetchStoreEntries())
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const mutate = async (id: string, action: () => Promise<void>) => {
    setBusy(id)
    try {
      await action()
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <main className="min-h-screen">
      <header className="border-b bg-background/95">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-4">
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <PackageOpen className="size-5" />
          <div>
            <h1 className="font-semibold">Capability Store</h1>
            <p className="text-xs text-muted-foreground">
              Install reusable OpenChatX capabilities.
            </p>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-5 py-6">
        {error ? (
          <div className="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          {entries.map((entry) => (
            <Card key={entry.id}>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">{entry.name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{entry.id}</div>
                  </div>
                  <Badge>{entry.kind}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm leading-6 text-muted-foreground">{entry.description}</p>
                <div className="flex flex-wrap gap-2">
                  {entry.tags.map((tag) => (
                    <Badge key={tag}>#{tag}</Badge>
                  ))}
                </div>
                <div className="mt-5">
                  {entry.installed ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === entry.id}
                      onClick={() => void mutate(entry.id, () => uninstallStoreEntry(entry.id))}
                    >
                      <Trash2 className="size-4" />
                      Uninstall
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={busy === entry.id}
                      onClick={() => void mutate(entry.id, () => installStoreEntry(entry.id))}
                    >
                      <Download className="size-4" />
                      Install
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </main>
  )
}
