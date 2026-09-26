import {
  ArrowLeft,
  Bot,
  Code2,
  Copy,
  Download,
  ExternalLink,
  PackageOpen,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import { NotificationToastStack, useNotificationToasts } from "../../components/notification-toast"
import { Badge } from "../../components/ui/badge"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import {
  fetchStoreEntries,
  fetchStoreReview,
  fetchStoreSourceFile,
  fetchStoreSourceTree,
  installStoreEntry,
  uninstallStoreEntry,
} from "../../lib/api"
import type {
  CapabilityStoreEntry,
  CapabilityStoreReview,
  CapabilityStoreSourceTree,
  RecommendedMcp,
} from "../../types"

type StoreSourceFilter = "all" | "builtin" | "community"

export function CapabilityStoreManager({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [entries, setEntries] = useState<CapabilityStoreEntry[]>([])
  const [recommendedMcps, setRecommendedMcps] = useState<RecommendedMcp[]>([])
  const [error, setError] = useState<string>()
  const [communityError, setCommunityError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [draftQuery, setDraftQuery] = useState("")
  const [query, setQuery] = useState("")
  const [source, setSource] = useState<StoreSourceFilter>("all")
  const [tree, setTree] = useState<CapabilityStoreSourceTree>()
  const [sourceFile, setSourceFile] = useState<{ path: string; content: string }>()
  const [review, setReview] = useState<CapabilityStoreReview>()
  const { toasts, pushToast, dismissToast } = useNotificationToasts()

  const load = useCallback(async () => {
    try {
      const result = await fetchStoreEntries(query, source)
      setEntries(result.entries)
      setRecommendedMcps(result.recommendedMcps)
      setCommunityError(result.communityError)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [query, source])

  useEffect(() => {
    void load()
  }, [load])

  const mutate = async (id: string, action: () => Promise<void>) => {
    setBusy(id)
    try {
      await action()
      await load()
      if (tree?.capability.id === id) {
        const nextTree = await fetchStoreSourceTree(id, tree.revision)
        setTree(nextTree)
      }
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const inspect = async (entry: CapabilityStoreEntry) => {
    setBusy(entry.id)
    setReview(undefined)
    setSourceFile(undefined)
    try {
      const nextTree = await fetchStoreSourceTree(entry.id, entry.revision)
      setTree(nextTree)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const readSource = async (path: string) => {
    if (!tree) return
    setBusy(`${tree.capability.id}:${path}`)
    try {
      const result = await fetchStoreSourceFile(tree.capability.id, path, tree.revision)
      setSourceFile({ path: result.path, content: result.content })
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const runReview = async () => {
    if (!tree) return
    setBusy(`${tree.capability.id}:review`)
    try {
      setReview(await fetchStoreReview(tree.capability.id, tree.revision))
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const copyAgentReviewPrompt = async () => {
    if (!tree) return
    const revision = tree.revision ? ` at revision ${tree.revision}` : ""
    const prompt =
      `Review OpenChatX capability ${tree.capability.id}${revision} before I install it. ` +
      "Use store_browse with actions review, source_tree, and source_read. Inspect the cited files and explain concrete risks; do not treat static analysis as a safety guarantee."
    await navigator.clipboard.writeText(prompt)
    pushToast(t("store.reviewPromptCopied"))
  }

  const copyRecommendedInstallPrompt = async (mcp: RecommendedMcp) => {
    const prompt =
      `Install and configure the MCP server from https://github.com/${mcp.repository} in OpenChatX. ` +
      "First inspect the repository README and installation instructions, then add the correct MCP server configuration and verify it works. Do not use unrelated global setup."
    await navigator.clipboard.writeText(prompt)
    pushToast(t("store.installPromptCopied", { name: mcp.name }))
  }

  const resolvedEntry = tree?.capability
  const installRevision = tree?.revision
  const visibleRecommended = recommendedMcps.filter((mcp) => {
    if (source === "builtin") return false
    if (!query) return true
    const needle = query.toLowerCase()
    return [mcp.name, mcp.publisher, mcp.repository, mcp.description, ...mcp.tags].some((value) =>
      value.toLowerCase().includes(needle)
    )
  })

  return (
    <main className="min-h-screen">
      <header className="border-b bg-background/95">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-4">
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
            {t("common.back")}
          </Button>
          <PackageOpen className="size-5" />
          <div>
            <h1 className="font-semibold">{t("store.title")}</h1>
            <p className="text-xs text-muted-foreground">{t("store.subtitle")}</p>
          </div>
        </div>
      </header>

      <NotificationToastStack
        toasts={toasts}
        title={t("store.systemNotification")}
        onDismiss={dismissToast}
      />

      <div className="mx-auto max-w-6xl px-5 py-6">
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <ShieldAlert className="size-4 text-amber-600" />
            {t("store.communityWarningTitle")}
          </div>
          <p className="mt-1 text-muted-foreground">
            {t("store.communityWarningPrefix")} <code>openchatx-capability</code>.{" "}
            {t("store.communityWarningSuffix")}
          </p>
        </div>

        <form
          className="mb-4 flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault()
            setQuery(draftQuery.trim())
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3">
            <Search className="size-4 text-muted-foreground" />
            <input
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder={t("store.searchPlaceholder")}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <select
            value={source}
            onChange={(event) => setSource(event.target.value as StoreSourceFilter)}
            className="h-9 rounded-md border bg-background px-3 text-sm"
          >
            <option value="all">{t("store.filterAll")}</option>
            <option value="builtin">{t("store.filterBuiltin")}</option>
            <option value="community">{t("store.filterCommunity")}</option>
          </select>
          <Button type="submit" size="sm">
            {t("store.search")}
          </Button>
        </form>

        {error ? (
          <div className="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {communityError ? (
          <div className="mb-4 rounded-md border border-amber-500/30 p-3 text-sm text-amber-700">
            {t("store.communityUnavailable")}: {communityError}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visibleRecommended.map((mcp) => (
            <Card key={mcp.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{mcp.name}</div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {t("store.byPublisher", { publisher: mcp.publisher })}
                    </div>
                  </div>
                  <Badge>{t("store.recommended")}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm leading-6 text-muted-foreground">
                  {localizeRecommendedDescription(mcp.id, mcp.description, t)}
                </p>
                <div className="flex flex-wrap gap-2">
                  {mcp.tags.slice(0, 4).map((tag) => (
                    <Badge key={tag}>#{tag}</Badge>
                  ))}
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.open(mcp.repositoryUrl, "_blank", "noopener,noreferrer")}
                  >
                    <Code2 className="size-4" />
                    {t("store.inspectSource")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void copyRecommendedInstallPrompt(mcp)}
                  >
                    <Copy className="size-4" />
                    {t("store.copyInstallPrompt")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}

          {entries.map((entry) => (
            <Card key={entry.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {localizeEntryName(entry.id, entry.name, t)}
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {entry.source === "github" ? entry.repository : entry.id}
                    </div>
                  </div>
                  <Badge>
                    {entry.source === "github" ? t("store.community") : t("store.builtin")}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm leading-6 text-muted-foreground">
                  {localizeEntryDescription(entry.id, entry.description, t)}
                </p>
                <div className="flex flex-wrap gap-2">
                  {entry.tags.map((tag) => (
                    <Badge key={tag}>#{tag}</Badge>
                  ))}
                  {entry.source === "github" && entry.stars !== undefined ? (
                    <Badge>★ {entry.stars}</Badge>
                  ) : null}
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === entry.id}
                    onClick={() => void inspect(entry)}
                  >
                    <Code2 className="size-4" />
                    {t("store.inspectSource")}
                  </Button>
                  {entry.source === "github" && entry.htmlUrl ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => window.open(entry.htmlUrl, "_blank", "noopener,noreferrer")}
                    >
                      <ExternalLink className="size-4" />
                      GitHub
                    </Button>
                  ) : null}
                  {entry.installed ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === entry.id}
                      onClick={() => void mutate(entry.id, () => uninstallStoreEntry(entry.id))}
                    >
                      <Trash2 className="size-4" />
                      {t("store.uninstall")}
                    </Button>
                  ) : entry.source === "builtin" ? (
                    <Button
                      size="sm"
                      disabled={busy === entry.id}
                      onClick={() => void mutate(entry.id, () => installStoreEntry(entry.id))}
                    >
                      <Download className="size-4" />
                      {t("store.install")}
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {tree && resolvedEntry ? (
          <Card className="mt-6">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-medium">
                    {t("store.sourceTitle", { name: resolvedEntry.name })}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {tree.revision
                      ? t("store.pinnedRevision", { revision: tree.revision })
                      : t("store.builtinSource")}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => void runReview()}>
                    <ShieldAlert className="size-4" />
                    {t("store.staticReview")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void copyAgentReviewPrompt()}>
                    <Bot className="size-4" />
                    {t("store.copyReviewPrompt")}
                  </Button>
                  {!resolvedEntry.installed ? (
                    <Button
                      size="sm"
                      disabled={busy === resolvedEntry.id}
                      onClick={() =>
                        void mutate(resolvedEntry.id, () =>
                          installStoreEntry(resolvedEntry.id, installRevision)
                        )
                      }
                    >
                      <Download className="size-4" />
                      {t("store.installRevision")}
                    </Button>
                  ) : null}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {review ? (
                <div className="mb-4 rounded-md border p-3 text-sm">
                  <div className="font-medium">{localizeReviewSummary(review.summary, t)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {localizeReviewNote(review.note, t)}
                  </div>
                  {review.findings.length > 0 ? (
                    <div className="mt-3 space-y-2">
                      {review.findings.slice(0, 12).map((finding) => (
                        <button
                          type="button"
                          key={`${finding.path}:${finding.category}:${finding.detail}`}
                          className="block w-full rounded border px-3 py-2 text-left"
                          onClick={() => void readSource(finding.path)}
                        >
                          <span className="font-medium">
                            {t(`store.reviewSeverity.${finding.severity}`)} ·{" "}
                            {localizeFindingCategory(finding.category, t)}
                          </span>
                          <span className="ml-2 text-muted-foreground">{finding.path}</span>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {localizeFindingDetail(finding.detail, t)}
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
                <div className="max-h-[560px] overflow-auto rounded-md border">
                  {tree.files.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      className="block w-full border-b px-3 py-2 text-left text-xs hover:bg-muted/50"
                      disabled={busy === `${resolvedEntry.id}:${file.path}`}
                      onClick={() => void readSource(file.path)}
                    >
                      <span className="break-all">{file.path}</span>
                      {file.size !== undefined ? (
                        <span className="ml-2 text-muted-foreground">{file.size} B</span>
                      ) : null}
                    </button>
                  ))}
                </div>
                <div className="min-h-48 overflow-auto rounded-md border bg-muted/20 p-3">
                  {sourceFile ? (
                    <>
                      <div className="mb-2 text-xs font-medium">{sourceFile.path}</div>
                      <pre className="whitespace-pre-wrap break-words text-xs leading-5">
                        {sourceFile.content}
                      </pre>
                    </>
                  ) : (
                    <div className="py-16 text-center text-sm text-muted-foreground">
                      {t("store.selectSourceFile")}
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </main>
  )
}

function localizeEntryName(
  id: string,
  fallback: string,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  if (id === "system-info") return t("store.systemInfoName")
  return fallback
}

function localizeReviewSummary(
  summary: string,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  const key = REVIEW_SUMMARY_KEYS[summary]
  return key ? t(key) : summary
}

function localizeReviewNote(
  note: string,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  if (
    note ===
    "This is static analysis, not a safety verdict. Ask ChatGPT to inspect cited files with store_browse action=source_read before deciding whether to install."
  ) {
    return t("store.reviewNote")
  }
  return note
}

function localizeFindingCategory(
  category: string,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  const key = FINDING_CATEGORY_KEYS[category]
  return key ? t(key) : category
}

function localizeFindingDetail(
  detail: string,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  const exact = FINDING_DETAIL_KEYS[detail]
  if (exact) return t(exact)

  const undeclared = detail.match(
    /^Observed (shell|network|filesystem|secrets) behavior is not declared in capability\.json permissions\.$/
  )
  if (undeclared) {
    return t("store.reviewFinding.undeclared", {
      permission: t(`store.reviewCategory.${undeclared[1]}`),
    })
  }

  const lifecycle = detail.match(/^package\.json defines a (.+) lifecycle script\.$/)
  if (lifecycle) {
    return t("store.reviewFinding.lifecycle", { name: lifecycle[1] })
  }

  return detail
}

const REVIEW_SUMMARY_KEYS: Record<string, string> = {
  "High-risk code patterns require manual inspection.": "store.reviewSummary.highRisk",
  "Potential risks were detected; inspect the cited source files before installing.":
    "store.reviewSummary.warning",
  "No obvious high-risk patterns were found in the reviewed text files.":
    "store.reviewSummary.clear",
}

const FINDING_CATEGORY_KEYS: Record<string, string> = {
  shell: "store.reviewCategory.shell",
  network: "store.reviewCategory.network",
  filesystem: "store.reviewCategory.filesystem",
  secrets: "store.reviewCategory.secrets",
  manifest: "store.reviewCategory.manifest",
  package: "store.reviewCategory.package",
}

const FINDING_DETAIL_KEYS: Record<string, string> = {
  "Source references process or shell execution.": "store.reviewFinding.shell",
  "Source contains network access indicators.": "store.reviewFinding.network",
  "Source contains filesystem access indicators.": "store.reviewFinding.filesystem",
  "Source references environment variables, credentials, or authorization values.":
    "store.reviewFinding.secrets",
  "package.json is not valid JSON.": "store.reviewFinding.invalidPackageJson",
}

function localizeRecommendedDescription(
  id: string,
  fallback: string,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  const key = RECOMMENDED_DESCRIPTION_KEYS[id]
  return key ? t(key) : fallback
}

function localizeEntryDescription(
  id: string,
  fallback: string,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  if (id === "system-info") return t("store.systemInfoDescription")
  return fallback
}

const RECOMMENDED_DESCRIPTION_KEYS: Record<string, string> = {
  "open-codex-computer-use": "store.recommended.openComputerUse",
  "open-browser-use": "store.recommended.openBrowserUse",
  "mcp-for-blender": "store.recommended.blender",
}
