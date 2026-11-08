// biome-ignore-all lint/security/noDangerouslySetInnerHtml: Highlight.js escapes untrusted source text before emitting markup.
// biome-ignore-all lint/suspicious/noArrayIndexKey: Immutable tool-output rows have no local state and may contain duplicate lines.
import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import css from "highlight.js/lib/languages/css"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import {
  Check,
  ChevronRight,
  CircleAlert,
  FileCode2,
  FileText,
  LoaderCircle,
  TerminalSquare,
} from "lucide-react"
import { useMemo } from "react"

import { useI18n } from "../../i18n"
import type { SubagentSessionEvent } from "../../types"
import { type DiffLine, describeTool, type FileDiff, type ToolDetails } from "./tool-detail-data"

hljs.registerLanguage("typescript", typescript)
hljs.registerLanguage("javascript", javascript)
hljs.registerLanguage("json", json)
hljs.registerLanguage("bash", bash)
hljs.registerLanguage("css", css)
hljs.registerLanguage("xml", xml)

function highlightCode(source: string, language?: string): string | undefined {
  if (!language || !hljs.getLanguage(language)) return undefined
  try {
    return hljs.highlight(source, { language, ignoreIllegals: true }).value
  } catch {
    return undefined
  }
}

function CodeText({ source, language }: { source: string; language?: string }) {
  const html = useMemo(() => highlightCode(source, language), [source, language])
  return html ? (
    <code className="hljs bg-transparent p-0" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <code className="bg-transparent p-0">{source}</code>
  )
}

function SourceOutput({
  text,
  language,
  failed,
}: {
  text: string
  language?: string
  failed?: boolean
}) {
  const lines = text.replaceAll("\r\n", "\n").split("\n")
  return (
    <div
      className={`tool-code-surface max-h-[340px] overflow-auto rounded-md border ${failed ? "border-destructive/35" : "border-border/70"}`}
    >
      <div className="w-max min-w-full py-2 font-mono text-[11px] leading-[21px]">
        {lines.map((line, i) => (
          <div key={i} className={`flex min-w-0 pr-4 ${failed ? "text-destructive/90" : ""}`}>
            <span className="w-11 shrink-0 select-none border-r border-border/40 pr-3 text-right tabular-nums text-muted-foreground/55">
              {i + 1}
            </span>
            <span className="min-w-0 pl-4 whitespace-pre">
              <CodeText source={line} language={language} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TerminalOutput({ text, failed = false }: { text: string; failed?: boolean }) {
  const output = text.replaceAll("\r\n", "\n")
  const lineCount = output.split("\n").length
  return (
    <div
      className={`tool-code-surface overflow-hidden rounded-md border ${failed ? "border-destructive/35" : "border-border/70"}`}
      data-testid="subagent-shell-output"
    >
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
        <span>stdout / stderr</span>
        <span className="tabular-nums">{lineCount} lines</span>
      </div>
      <section
        aria-label="Shell output"
        className="max-h-[360px] min-h-0 overflow-auto overscroll-contain"
      >
        <pre
          className={`w-max min-w-full p-3 font-mono text-[11px] leading-[20px] whitespace-pre ${failed ? "text-destructive" : "text-foreground/85"}`}
        >
          {output}
        </pre>
      </section>
    </div>
  )
}

function FileDiffCard({ file }: { file: FileDiff }) {
  const rows = file.lines
  return (
    <details
      className="group/file overflow-hidden rounded-md border border-border/80"
      open
      data-testid="subagent-diff-file"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 bg-muted/25 px-3 py-2.5 text-[12px] hover:bg-muted/40">
        <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={file.path}>
          {file.path}
        </span>
        {file.snippet && <span className="text-[10px] text-muted-foreground">Snippet</span>}
        {file.additions > 0 && (
          <span className="shrink-0 font-mono text-[11px] text-[var(--syntax-addition)]">
            +{file.additions}
          </span>
        )}
        {file.deletions > 0 && (
          <span className="shrink-0 font-mono text-[11px] text-[var(--syntax-deletion)]">
            -{file.deletions}
          </span>
        )}
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/file:rotate-90" />
      </summary>
      {rows.length > 0 && (
        <div
          className="tool-code-surface max-h-[440px] overflow-auto border-t border-border/60"
          data-testid="subagent-diff-code"
        >
          <div className="min-w-[420px] py-1 font-mono text-[11px] leading-[20px]">
            {rows.map((line, i) => (
              <DiffCodeRow key={i} line={line} language={file.language} />
            ))}
          </div>
        </div>
      )}
    </details>
  )
}

function DiffCodeRow({ line, language }: { line: DiffLine; language: string }) {
  if (line.kind === "hunk")
    return (
      <div className="border-y border-border/30 bg-muted/25 px-3 py-1 text-[10px] text-muted-foreground">
        {line.text}
      </div>
    )
  return (
    <div
      className={`subagent-diff-row ${line.kind === "add" ? "subagent-diff-add" : line.kind === "remove" ? "subagent-diff-remove" : ""}`}
      data-diff-kind={line.kind}
    >
      <span className="subagent-diff-gutter">{line.oldNumber ?? ""}</span>
      <span className="subagent-diff-gutter">{line.newNumber ?? ""}</span>
      <span className="select-none text-center text-muted-foreground/70">
        {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words pl-1 pr-4">
        <CodeText source={line.text} language={language} />
      </span>
    </div>
  )
}

function ToolResult({
  detail,
  status,
}: {
  detail: ToolDetails
  status?: SubagentSessionEvent["status"]
}) {
  const failed = status === "failed"
  if (detail.kind === "edit" && detail.files.length > 0) {
    return (
      <div className="space-y-2">
        {detail.files.map((file, i) => (
          <FileDiffCard key={`${file.path}:${i}`} file={file} />
        ))}
        {detail.result && (
          <details className="group/output rounded-md border border-border/60">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground hover:bg-muted/30">
              <ChevronRight className="size-3 transition-transform group-open/output:rotate-90" />
              Output
              {failed && <CircleAlert className="size-3 text-destructive" />}
            </summary>
            <div className="border-t border-border/50 p-2">
              <SourceOutput text={detail.result} failed={failed} />
            </div>
          </details>
        )}
      </div>
    )
  }
  if (detail.kind === "shell") {
    return (
      <div className="space-y-2">
        {detail.command && (
          <div className="flex gap-2 rounded-md bg-muted/30 px-3 py-2 font-mono text-[11px]">
            <TerminalSquare className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 break-all">{detail.command}</span>
          </div>
        )}
        <TerminalOutput text={detail.result} failed={failed} />
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {detail.kind === "search" && <SearchFiles text={detail.result} />}
      <SourceOutput text={detail.result} language={detail.language} failed={failed} />
      {detail.argumentsText && !detail.command && (
        <details className="group/input mt-1">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-[11px] text-muted-foreground">
            <ChevronRight className="size-3 transition-transform group-open/input:rotate-90" />
            Input
          </summary>
          <SourceOutput text={prettyJson(detail.argumentsText)} language="json" />
        </details>
      )}
    </div>
  )
}

function SearchFiles({ text }: { text: string }) {
  const entries = text
    .split("\n")
    .filter((line) =>
      /^(?:[\w./~-]+\.(?:ts|tsx|js|jsx|json|css|html|md|py|go|rs|sh)(?::\d+)?|\/[\w./-]+\/[^\s]+\.[a-z]+(?::\d+)?)/iu.test(
        line.trim()
      )
    )
    .slice(0, 24)
  if (entries.length < 2) return null
  return (
    <div className="divide-y divide-border/40 overflow-hidden rounded-md border border-border/70">
      {entries.map((line, i) => (
        <div key={i} className="flex min-w-0 items-center gap-2 px-3 py-1.5 font-mono text-[11px]">
          <FileText className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-foreground/85">{line.trim()}</span>
        </div>
      ))}
    </div>
  )
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

export function ToolAction({ event }: { event: SubagentSessionEvent }) {
  const { t } = useI18n()
  const detail = useMemo(() => describeTool(event), [event])
  return (
    <details className="group/action min-w-0" data-testid="subagent-tool-action">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded px-1 py-2 text-[12px] hover:bg-muted/35">
        <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-open/action:rotate-90" />
        <span className="shrink-0 font-medium text-foreground">{detail.name}</span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
          title={detail.subtitle}
        >
          {detail.subtitle}
        </span>
        {detail.kind === "edit" && detail.files.length > 0 && (
          <span className="hidden shrink-0 gap-1.5 font-mono text-[10px] sm:flex">
            {detail.files.reduce((sum, file) => sum + file.additions, 0) > 0 && (
              <span className="text-[var(--syntax-addition)]">
                +{detail.files.reduce((sum, file) => sum + file.additions, 0)}
              </span>
            )}
            {detail.files.reduce((sum, file) => sum + file.deletions, 0) > 0 && (
              <span className="text-[var(--syntax-deletion)]">
                -{detail.files.reduce((sum, file) => sum + file.deletions, 0)}
              </span>
            )}
          </span>
        )}
        {event.status === "running" ? (
          <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : event.status === "failed" ? (
          <CircleAlert className="size-3 shrink-0 text-destructive" />
        ) : (
          <Check className="size-3 shrink-0 text-muted-foreground/60" />
        )}
        <span
          className={`shrink-0 text-[10px] ${event.status === "failed" ? "text-destructive" : "text-muted-foreground/70"}`}
        >
          {t(`subagents.status.${event.status ?? "completed"}`)}
        </span>
      </summary>
      <div className="mb-2 ml-4 mt-1" data-testid="subagent-tool-detail">
        <ToolResult detail={detail} status={event.status} />
      </div>
    </details>
  )
}
