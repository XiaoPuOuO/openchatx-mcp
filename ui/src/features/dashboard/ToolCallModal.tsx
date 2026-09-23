// biome-ignore-all lint/security/noDangerouslySetInnerHtml: Highlight.js escapes source text and emits the markup required for syntax highlighting.
import * as Dialog from "@radix-ui/react-dialog"
import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import diff from "highlight.js/lib/languages/diff"
import json from "highlight.js/lib/languages/json"
import "highlight.js/styles/github.css"
import { X } from "lucide-react"

import { Button } from "../../components/ui/button"
import type { AgentCall } from "../../types"

hljs.registerLanguage("bash", bash)
hljs.registerLanguage("diff", diff)
hljs.registerLanguage("json", json)

export function ToolCallModal({ call, onClose }: { call?: AgentCall; onClose: () => void }) {
  const detail = call?.detail || call?.summary || "No captured input for this tool call."
  const highlighted =
    call?.detailLanguage && hljs.getLanguage(call.detailLanguage)
      ? hljs.highlight(detail, { language: call.detailLanguage }).value
      : hljs.highlightAuto(detail).value

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
                aria-label="Close tool call details"
              >
                <X className="size-4" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 overflow-auto p-5">
            <pre className="overflow-x-auto rounded-lg border bg-muted/30 p-4 text-xs leading-5">
              <code
                className="hljs bg-transparent p-0"
                dangerouslySetInnerHTML={{ __html: highlighted }}
              />
            </pre>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
