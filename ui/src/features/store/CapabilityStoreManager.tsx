import {
  ArrowLeft,
  Bot,
  Code2,
  Download,
  ExternalLink,
  PackageOpen,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import { Badge } from "../../components/ui/badge"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
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
      "Use store_review, store_source_tree, and store_source_read. Inspect the cited files and explain concrete risks; do not treat static analysis as a safety guarantee."
    await navigator.clipboard.writeText(prompt)
  }

  const resolvedEntry = tree?.capability
  const installRevision = tree?.revision

  return (
    <main className="min-h-screen">
      <header className="border-b bg-background/95">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-4">
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <PackageOpen className="size-5" />
          <div>
            <h1 className="font-semibold">Capability Store</h1>
            <p className="text-xs text-muted-foreground">
              Built-in capabilities plus unreviewed community source discovered directly from
              GitHub.
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-6">
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <ShieldAlert className="size-4 text-amber-600" />
            Community capabilities are not reviewed or endorsed by OpenChatX.
          </div>
          <p className="mt-1 text-muted-foreground">
            Community discovery uses public GitHub repositories tagged{" "}
            <code>openchatx-capability</code>. Inspect the source or ask ChatGPT to review the exact
            revision before installing.
          </p>
        </div>

        {recommendedMcps.length > 0 ? (
          <section className="mb-6">
            <div className="mb-3">
              <h2 className="font-semibold">OpenChatX Picks</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                MCP projects curated by OpenChatX as useful starting points. Recommendation does not
                mean security certification.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {recommendedMcps.map((mcp) => (
                <Card key={mcp.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">{mcp.name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">by {mcp.publisher}</div>
                      </div>
                      <Badge>Recommended</Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm leading-6 text-muted-foreground">{mcp.description}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {mcp.tags.slice(0, 4).map((tag) => (
                        <Badge key={tag}>#{tag}</Badge>
                      ))}
                    </div>
                    <a
                      className="mt-4 inline-flex items-center gap-1 text-xs text-muted-foreground underline"
                      href={mcp.repositoryUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink className="size-3" />
                      {mcp.repository}
                    </a>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ) : null}

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
              placeholder="Search capabilities"
              className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <select
            value={source}
            onChange={(event) => setSource(event.target.value as StoreSourceFilter)}
            className="h-9 rounded-md border bg-background px-3 text-sm"
          >
            <option value="all">Built-in + Community</option>
            <option value="builtin">Built-in</option>
            <option value="community">Community</option>
          </select>
          <Button type="submit" size="sm">
            Search
          </Button>
        </form>

        {error ? (
          <div className="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {communityError ? (
          <div className="mb-4 rounded-md border border-amber-500/30 p-3 text-sm text-amber-700">
            Community discovery unavailable: {communityError}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {entries.map((entry) => (
            <Card key={entry.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{entry.name}</div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {entry.source === "github" ? entry.repository : entry.id}
                    </div>
                  </div>
                  <Badge>{entry.source === "github" ? "community" : "built-in"}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm leading-6 text-muted-foreground">{entry.description}</p>
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
                    Inspect source
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
                      Uninstall
                    </Button>
                  ) : entry.source === "builtin" ? (
                    <Button
                      size="sm"
                      disabled={busy === entry.id}
                      onClick={() => void mutate(entry.id, () => installStoreEntry(entry.id))}
                    >
                      <Download className="size-4" />
                      Install
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
                  <div className="font-medium">Source: {resolvedEntry.name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {tree.revision ? `Pinned revision ${tree.revision}` : "Built-in source"}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => void runReview()}>
                    <ShieldAlert className="size-4" />
                    Static review
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void copyAgentReviewPrompt()}>
                    <Bot className="size-4" />
                    Copy Agent review prompt
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
                      Install this revision
                    </Button>
                  ) : null}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {review ? (
                <div className="mb-4 rounded-md border p-3 text-sm">
                  <div className="font-medium">{review.summary}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{review.note}</div>
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
                            {finding.severity.toUpperCase()} · {finding.category}
                          </span>
                          <span className="ml-2 text-muted-foreground">{finding.path}</span>
                          <div className="mt-1 text-xs text-muted-foreground">{finding.detail}</div>
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
                      Select a source file to inspect it here.
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card className="mt-6">
          <CardHeader>
            <div className="font-medium">Publish a community capability</div>
          </CardHeader>
          <CardContent className="text-sm leading-6 text-muted-foreground">
            No OpenChatX Store server is required. Publish a public GitHub repository, put{" "}
            <code>capability.json</code> at its root, and add the repository topic{" "}
            <code>openchatx-capability</code>. OpenChatX discovers it directly from GitHub. In
            ChatGPT, use <code>store_publish_check</code> on your local directory before publishing.
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
