import ReactMarkdown from "react-markdown"
import rehypeKatex from "rehype-katex"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"

import "katex/dist/katex.min.css"

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[^\n]*$/u

/**
 * Models commonly emit TeX \(...\) and \[...\]; remark-math supports
 * dollar delimiters instead. Leave fenced and inline code untouched.
 */
export function normalizeMathDelimiters(markdown: string): string {
  const result: string[] = []
  const prose: string[] = []
  let fence: { marker: string; length: number } | undefined
  const flush = () => {
    if (prose.length) result.push(normalizeProse(prose.join("\n")))
    prose.length = 0
  }
  for (const line of markdown.split("\n")) {
    if (fence) {
      result.push(line)
      const trimmed = line.trim()
      const { marker, length } = fence
      if (trimmed.length >= length && [...trimmed].every((c) => c === marker)) fence = undefined
      continue
    }
    const opened = FENCE_OPEN.exec(line)
    if (opened) {
      flush()
      fence = { marker: opened[1][0], length: opened[1].length }
      result.push(line)
      continue
    }
    prose.push(line)
  }
  flush()
  return result.join("\n")
}

function normalizeProse(source: string): string {
  // Backtick spans are preserved verbatim even when they contain TeX delimiters.
  return source.replace(
    /(`+)([\s\S]*?)\1|(?<!\\)\\\[([\s\S]*?)\\\]|(?<!\\)\\\(([\s\S]*?)\\\)/gu,
    (
      match,
      ticks: string | undefined,
      _code: string | undefined,
      display: string | undefined,
      inline: string | undefined
    ) => {
      if (ticks) return match
      if (display !== undefined) return `\n\n$$\n${display.trim()}\n$$\n\n`
      if (inline !== undefined) return `$${inline.trim()}$`
      return match
    }
  )
}

export function SubagentMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, output: "htmlAndMathml" }]]}
    >
      {normalizeMathDelimiters(text)}
    </ReactMarkdown>
  )
}
