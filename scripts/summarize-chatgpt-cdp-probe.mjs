import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { resolve } from "node:path"

const input = process.argv[2]
if (!input || input === "--help") {
  console.log("Usage: npm run probe:chatgpt-cdp:summary -- path/to/chatgpt-cdp-*.jsonl")
  process.exit(input ? 0 : 1)
}

const path = resolve(input)
const counts = new Map()
const candidateSignals = []
const domStates = []
let first
let last
let rows = 0

const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })
for await (const line of lines) {
  if (!line.trim()) continue
  let row
  try {
    row = JSON.parse(line)
  } catch {
    continue
  }
  rows += 1
  first ??= row
  last = row
  counts.set(row.type, (counts.get(row.type) ?? 0) + 1)
  if (row.type === "dom.state") domStates.push(row)
  if (isCandidateLivenessSignal(row)) candidateSignals.push(row)
}

console.log(`Trace: ${path}`)
console.log(`Rows: ${rows}`)
if (first && last) console.log(`Span: ${Math.max(0, Number(last.elapsed_ms) - Number(first.elapsed_ms))} ms`)

console.log("\nEvent counts:")
for (const [type, count] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  console.log(`${String(count).padStart(7)}  ${type}`)
}

console.log("\nLongest candidate-liveness gaps:")
const gaps = []
for (let index = 1; index < candidateSignals.length; index += 1) {
  const before = candidateSignals[index - 1]
  const after = candidateSignals[index]
  gaps.push({ gap: Number(after.elapsed_ms) - Number(before.elapsed_ms), before, after })
}
for (const item of gaps.sort((a, b) => b.gap - a.gap).slice(0, 12)) {
  console.log(`${String(item.gap).padStart(7)} ms  ${describe(item.before)} -> ${describe(item.after)}`)
}

console.log("\nDOM streaming states:")
for (const row of collapseDomStates(domStates)) {
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {}
  const text = Array.isArray(payload.streaming_status_text) ? payload.streaming_status_text.join(" | ") : ""
  console.log(
    `+${String(row.elapsed_ms).padStart(7)} ms  visible_status=${payload.visible_streaming_status_count ?? "?"} stop=${payload.stop_button_visible ?? "?"} turns=${payload.turn_count ?? "?"} assistants=${payload.assistant_message_count ?? "?"}${text ? `  ${JSON.stringify(text.slice(0, 220))}` : ""}`
  )
}

function isCandidateLivenessSignal(row) {
  if (row.type === "dom.state") return true
  if (row.type === "Network.dataReceived" && isConversationUrl(row.url)) return true
  if (row.type === "Network.streamResourceContent" && isConversationUrl(row.url)) return true
  if (row.type === "Network.eventSourceMessageReceived" && isConversationUrl(row.url)) return true
  if (row.type === "Network.webSocketFrameReceived") return typeof row.payload_data === "string" && row.payload_data.includes("conversation-turn-")
  if (row.type === "Network.responseBody" && isConversationUrl(row.url)) return true
  return false
}

function isConversationUrl(value) {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    return (
      url.hostname === "chatgpt.com" &&
      (url.pathname === "/backend-api/f/conversation" ||
        url.pathname === "/backend-api/f/conversation/resume" ||
        url.pathname.startsWith("/backend-api/conversations/"))
    )
  } catch {
    return false
  }
}

function describe(row) {
  if (row.type === "dom.state") {
    const payload = row.payload && typeof row.payload === "object" ? row.payload : {}
    return `dom.state(status=${payload.visible_streaming_status_count ?? "?"},stop=${payload.stop_button_visible ?? "?"})`
  }
  return row.type
}

function collapseDomStates(rows) {
  const result = []
  let previous
  for (const row of rows) {
    const payload = row.payload && typeof row.payload === "object" ? row.payload : {}
    const signature = JSON.stringify({
      text: payload.streaming_status_text,
      visible: payload.visible_streaming_status_count,
      stop: payload.stop_button_visible,
      turns: payload.turn_count,
      assistants: payload.assistant_message_count,
    })
    if (signature === previous) continue
    previous = signature
    result.push(row)
  }
  return result
}
