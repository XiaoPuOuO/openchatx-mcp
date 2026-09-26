// biome-ignore-all lint/security/noDangerouslySetInnerHtml: Highlight.js escapes source text and emits the markup required for syntax highlighting.
import * as Dialog from "@radix-ui/react-dialog"
import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import diff from "highlight.js/lib/languages/diff"
import json from "highlight.js/lib/languages/json"
import "highlight.js/styles/github.css"
import { X } from "lucide-react"

import { Button } from "../../components/ui/button"
import { useI18n } from "../../i18n"
import type { AgentCall } from "../../types"

hljs.registerLanguage("bash", bash)
hljs.registerLanguage("diff", diff)
hljs.registerLanguage("json", json)

export function ToolCallModal({ call, onClose }: { call?: AgentCall; onClose: () => void }) {
  const { t } = useI18n()
  const inputDetail = call?.detail || call?.summary || t("toolCall.noInput")
  const resultDetail =
    call?.resultDetail ||
    (call?.status === "failed" ? call.error : undefined) ||
    (call?.status === "running" ? t("toolCall.waitingResult") : t("toolCall.noResult"))

  return (
    <Dialog.Root open={Boolean(call)} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[min(760px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border bg-background shadow-2xl outline-none">
          <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-base font-semibold">{call?.tool}</Dialog.Title>
              {call?.summary ? (
                <Dialog.Description className="mt-1 truncate text-xs text-muted-foreground">
                  {call.summary}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label={t("toolCall.close")}
              >
                <X className="size-4" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 space-y-5 overflow-auto p-5">
            <ToolCallSection
              label={t("toolCall.input")}
              detail={inputDetail}
              language={call?.detailLanguage}
            />
            <ToolCallSection
              label={t("toolCall.returnedToAgent")}
              detail={resultDetail}
              language={call?.resultDetailLanguage}
              failed={call?.status === "failed"}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ToolCallSection({
  label,
  detail,
  language,
  failed = false,
}: {
  label: string
  detail: string
  language?: string
  failed?: boolean
}) {
  const highlighted =
    language && hljs.getLanguage(language) ? hljs.highlight(detail, { language }).value : undefined

  return (
    <section>
      <div className={`mb-2 text-xs font-semibold ${failed ? "text-red-700" : "text-foreground"}`}>
        {label}
      </div>
      <pre
        className={`overflow-x-auto rounded-lg border p-4 text-xs leading-5 ${
          failed ? "border-red-200 bg-red-50 text-red-800" : "bg-muted/30"
        }`}
      >
        {highlighted ? (
          <code
            className="hljs bg-transparent p-0"
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <code className="bg-transparent p-0">{detail}</code>
        )}
      </pre>
    </section>
  )
}
