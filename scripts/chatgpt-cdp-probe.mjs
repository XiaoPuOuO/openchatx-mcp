import { createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { chromium } from "playwright-core"

import { MCP_CONFIG } from "../src/config.ts"

const args = parseArgs(process.argv.slice(2))
const startedAt = Date.now()
const defaultName = `chatgpt-cdp-${new Date().toISOString().replaceAll(":", "-")}.jsonl`
const outputPath = resolve(args.out ?? `test/live/artifacts/${defaultName}`)

await mkdir(dirname(outputPath), { recursive: true })
const output = createWriteStream(outputPath, { flags: "wx" })
let sequence = 0
let pageSequence = 0
let stopping = false
const sessions = new Set()
const attachedPages = new WeakSet()

function record(type, data = {}) {
  const row = {
    seq: ++sequence,
    at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt,
    type,
    ...data,
  }
  output.write(`${JSON.stringify(row)}\n`)
}

record("probe.started", {
  cdp_endpoint: sanitizeUrl(MCP_CONFIG.chatGpt.cdpEndpoint),
  output: outputPath,
  capture_bodies: args.captureBodies,
  dom_snapshots: args.domSnapshots,
})

const browser = await chromium.connectOverCDP(MCP_CONFIG.chatGpt.cdpEndpoint, { timeout: 5_000 })
const contexts = browser.contexts()
if (contexts.length === 0) throw new Error("Connected Chrome exposed no browser contexts.")

for (const context of contexts) {
  for (const page of context.pages()) void attachPage(context, page)
  context.on("page", (page) => void attachPage(context, page))
}

console.log(`ChatGPT CDP probe recording to ${outputPath}`)
console.log("Press Ctrl-C to stop. The probe does not launch, close, reload, or navigate Chrome.")

const durationTimer = args.durationMs
  ? setTimeout(() => {
      void stop("duration")
    }, args.durationMs)
  : undefined

process.on("SIGINT", () => void stop("SIGINT"))
process.on("SIGTERM", () => void stop("SIGTERM"))

await new Promise((resolvePromise) => {
  globalThis.__shellbyProbeResolve = resolvePromise
})

async function attachPage(context, page) {
  if (attachedPages.has(page)) return
  attachedPages.add(page)
  const pageId = `page-${++pageSequence}`
  const requestUrls = new Map()
  const responseMeta = new Map()
  record("page.attached", { page_id: pageId, url: sanitizeUrl(page.url()) })

  page.on("close", () => record("page.closed", { page_id: pageId, url: sanitizeUrl(page.url()) }))
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) record("page.navigated", { page_id: pageId, url: sanitizeUrl(frame.url()) })
  })

  let session
  try {
    session = await context.newCDPSession(page)
    sessions.add(session)
    await Promise.all([
      session.send("Network.enable", { maxPostDataSize: 4 * 1024 * 1024 }),
      session.send("Page.enable"),
      session.send("Runtime.enable"),
      session.send("Log.enable"),
      session.send("Performance.enable"),
    ])
    await session.send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => undefined)
  } catch (error) {
    record("page.attach_failed", { page_id: pageId, url: sanitizeUrl(page.url()), error: errorText(error) })
    return
  }

  session.on("Network.requestWillBeSent", (event) => {
    requestUrls.set(event.requestId, event.request?.url)
    record("Network.requestWillBeSent", {
      page_id: pageId,
      request_id: event.requestId,
      url: sanitizeUrl(event.request?.url),
      method: event.request?.method,
      resource_type: event.type,
      initiator_type: event.initiator?.type,
      post_data: event.request?.postData,
      headers: sanitizeHeaders(event.request?.headers),
    })
  })

  session.on("Network.responseReceived", (event) => {
    const url = event.response?.url ?? requestUrls.get(event.requestId)
    responseMeta.set(event.requestId, { url, mimeType: event.response?.mimeType })
    record("Network.responseReceived", {
      page_id: pageId,
      request_id: event.requestId,
      url: sanitizeUrl(url),
      status: event.response?.status,
      mime_type: event.response?.mimeType,
      resource_type: event.type,
      protocol: event.response?.protocol,
      from_disk_cache: event.response?.fromDiskCache,
      from_service_worker: event.response?.fromServiceWorker,
      headers: sanitizeHeaders(event.response?.headers),
    })
    if (isStreamingConversationUrl(url)) {
      void session
        .send("Network.streamResourceContent", { requestId: event.requestId })
        .then((result) => {
          const bufferedData = typeof result.bufferedData === "string" ? result.bufferedData : ""
          record("Network.streamResourceContent", {
            page_id: pageId,
            request_id: event.requestId,
            url: sanitizeUrl(url),
            buffered_data_base64: bufferedData,
            buffered_data_utf8: decodeBase64(bufferedData),
          })
        })
        .catch((error) => {
          record("Network.streamResourceContentFailed", { page_id: pageId, request_id: event.requestId, url: sanitizeUrl(url), error: errorText(error) })
        })
    }
  })

  session.on("Network.dataReceived", (event) => {
    record("Network.dataReceived", {
      page_id: pageId,
      request_id: event.requestId,
      url: sanitizeUrl(requestUrls.get(event.requestId)),
      data_length: event.dataLength,
      encoded_data_length: event.encodedDataLength,
      has_data: typeof event.data === "string" && event.data.length > 0,
      data_base64: event.data,
      data_utf8: isStreamingConversationUrl(requestUrls.get(event.requestId)) ? decodeBase64(event.data) : undefined,
    })
  })

  session.on("Network.loadingFinished", (event) => {
    const meta = responseMeta.get(event.requestId)
    record("Network.loadingFinished", {
      page_id: pageId,
      request_id: event.requestId,
      url: sanitizeUrl(meta?.url ?? requestUrls.get(event.requestId)),
      encoded_data_length: event.encodedDataLength,
    })
    if (args.captureBodies && shouldCaptureBody(meta?.url ?? requestUrls.get(event.requestId))) {
      void captureResponseBody(session, pageId, event.requestId, meta?.url ?? requestUrls.get(event.requestId))
    }
  })

  session.on("Network.loadingFailed", (event) => {
    record("Network.loadingFailed", {
      page_id: pageId,
      request_id: event.requestId,
      url: sanitizeUrl(requestUrls.get(event.requestId)),
      resource_type: event.type,
      error_text: event.errorText,
      canceled: event.canceled,
      blocked_reason: event.blockedReason,
    })
  })

  session.on("Network.webSocketCreated", (event) => {
    record("Network.webSocketCreated", { page_id: pageId, request_id: event.requestId, url: sanitizeUrl(event.url) })
  })
  session.on("Network.webSocketWillSendHandshakeRequest", (event) => {
    record("Network.webSocketWillSendHandshakeRequest", {
      page_id: pageId,
      request_id: event.requestId,
      headers: sanitizeHeaders(event.request?.headers),
    })
  })
  session.on("Network.webSocketHandshakeResponseReceived", (event) => {
    record("Network.webSocketHandshakeResponseReceived", {
      page_id: pageId,
      request_id: event.requestId,
      status: event.response?.status,
      status_text: event.response?.statusText,
      headers: sanitizeHeaders(event.response?.headers),
    })
  })
  session.on("Network.webSocketFrameSent", (event) => {
    record("Network.webSocketFrameSent", {
      page_id: pageId,
      request_id: event.requestId,
      opcode: event.response?.opcode,
      mask: event.response?.mask,
      payload_data: event.response?.payloadData,
    })
  })
  session.on("Network.webSocketFrameReceived", (event) => {
    record("Network.webSocketFrameReceived", {
      page_id: pageId,
      request_id: event.requestId,
      opcode: event.response?.opcode,
      mask: event.response?.mask,
      payload_data: event.response?.payloadData,
    })
  })
  session.on("Network.webSocketFrameError", (event) => {
    record("Network.webSocketFrameError", { page_id: pageId, request_id: event.requestId, error_message: event.errorMessage })
  })
  session.on("Network.webSocketClosed", (event) => {
    record("Network.webSocketClosed", { page_id: pageId, request_id: event.requestId })
  })
  session.on("Network.eventSourceMessageReceived", (event) => {
    record("Network.eventSourceMessageReceived", {
      page_id: pageId,
      request_id: event.requestId,
      event_name: event.eventName,
      event_id: event.eventId,
      data: event.data,
    })
  })

  session.on("Page.lifecycleEvent", (event) => {
    record("Page.lifecycleEvent", { page_id: pageId, frame_id: event.frameId, name: event.name, loader_id: event.loaderId })
  })
  session.on("Page.domContentEventFired", () => record("Page.domContentEventFired", { page_id: pageId }))
  session.on("Page.loadEventFired", () => record("Page.loadEventFired", { page_id: pageId }))
  session.on("Runtime.consoleAPICalled", (event) => {
    record("Runtime.consoleAPICalled", {
      page_id: pageId,
      console_type: event.type,
      args: event.args?.map(remoteObjectSummary),
      stack_trace: event.stackTrace,
    })
  })
  session.on("Runtime.exceptionThrown", (event) => {
    record("Runtime.exceptionThrown", { page_id: pageId, exception_details: event.exceptionDetails })
  })
  session.on("Log.entryAdded", (event) => {
    record("Log.entryAdded", { page_id: pageId, entry: event.entry })
  })

  await installDomProbe(session, pageId)
  record("page.cdp_ready", { page_id: pageId, url: sanitizeUrl(page.url()) })
}

async function installDomProbe(session, pageId) {
  const bindingName = "__shellbyCdpProbeEmit"
  session.on("Runtime.bindingCalled", (event) => {
    if (event.name !== bindingName) return
    let payload = event.payload
    try {
      payload = JSON.parse(event.payload)
    } catch {
      // Preserve raw binding payload.
    }
    record("dom.state", { page_id: pageId, execution_context_id: event.executionContextId, payload })
    if (args.domSnapshots) void captureDomSnapshot(session, pageId, payload)
  })

  await session.send("Runtime.addBinding", { name: bindingName }).catch((error) => {
    record("dom.binding_failed", { page_id: pageId, error: errorText(error) })
  })
  await session.send("Page.addScriptToEvaluateOnNewDocument", { source: domProbeSource(bindingName) }).catch(() => undefined)
  await session.send("Runtime.evaluate", { expression: domProbeSource(bindingName), awaitPromise: false }).catch((error) => {
    record("dom.install_failed", { page_id: pageId, error: errorText(error) })
  })
}

function domProbeSource(bindingName) {
  return `(() => {
    if (globalThis.__shellbyCdpProbeInstalled) return;
    const emit = globalThis[${JSON.stringify(bindingName)}];
    let previous = "";
    let queued = false;
    const visible = (el) => !!el && el instanceof HTMLElement && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden" && el.getClientRects().length > 0;
    const read = () => {
      queued = false;
      const statusNodes = [...document.querySelectorAll("[data-streaming-response-status]")];
      const visibleStatuses = statusNodes.filter(visible);
      const stop = document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop generating" i], button[aria-label="Stop"]');
      const turns = [...document.querySelectorAll('section[data-testid^="conversation-turn-"]')];
      const assistant = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      const toolish = [...document.querySelectorAll('[data-message-author-role="tool"], [data-testid*="tool" i], [data-testid*="search" i]')];
      const latestAssistantText = (assistant.at(-1)?.textContent ?? "").trim();
      const state = {
        href: location.href,
        visibility_state: document.visibilityState,
        title: document.title,
        streaming_status_count: statusNodes.length,
        visible_streaming_status_count: visibleStatuses.length,
        streaming_status_text: visibleStatuses.map((el) => (el.textContent ?? "").trim()).filter(Boolean),
        stop_button_visible: visible(stop),
        turn_count: turns.length,
        assistant_message_count: assistant.length,
        toolish_node_count: toolish.length,
        latest_assistant_text_length: latestAssistantText.length,
        latest_assistant_text_excerpt: latestAssistantText.slice(0, 500),
      };
      const signature = JSON.stringify(state);
      if (signature === previous) return;
      previous = signature;
      try { emit(signature); } catch {}
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(read);
    };
    const install = () => {
      if (globalThis.__shellbyCdpProbeInstalled) return;
      if (!document.documentElement) {
        setTimeout(install, 0);
        return;
      }
      globalThis.__shellbyCdpProbeInstalled = true;
      new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      document.addEventListener("visibilitychange", schedule);
      setInterval(schedule, 1000);
      read();
    };
    install();
  })()`
}

async function captureResponseBody(session, pageId, requestId, url) {
  try {
    const result = await session.send("Network.getResponseBody", { requestId })
    const body = typeof result.body === "string" ? result.body : ""
    record("Network.responseBody", {
      page_id: pageId,
      request_id: requestId,
      url: sanitizeUrl(url),
      base64_encoded: result.base64Encoded,
      body_length: body.length,
      body,
    })
  } catch (error) {
    record("Network.responseBodyFailed", { page_id: pageId, request_id: requestId, url: sanitizeUrl(url), error: errorText(error) })
  }
}

async function captureDomSnapshot(session, pageId, reason) {
  try {
    const snapshot = await session.send("DOMSnapshot.captureSnapshot", {
      computedStyles: ["display", "visibility"],
      includePaintOrder: false,
      includeDOMRects: false,
      includeBlendedBackgroundColors: false,
      includeTextColorOpacities: false,
    })
    record("DOMSnapshot.captureSnapshot", { page_id: pageId, reason, snapshot })
  } catch (error) {
    record("DOMSnapshot.captureSnapshotFailed", { page_id: pageId, error: errorText(error) })
  }
}

async function stop(reason) {
  if (stopping) return
  stopping = true
  if (durationTimer) clearTimeout(durationTimer)
  record("probe.stopping", { reason })
  for (const session of sessions) await session.detach().catch(() => undefined)
  record("probe.stopped", { reason })
  await new Promise((resolvePromise) => output.end(resolvePromise))
  console.log(`Stopped. Trace: ${outputPath}`)
  process.exit(0)
}

function parseArgs(argv) {
  const result = { out: undefined, durationMs: undefined, captureBodies: false, domSnapshots: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--out") result.out = argv[++index]
    else if (arg === "--duration-ms") result.durationMs = Number(argv[++index])
    else if (arg === "--capture-bodies") result.captureBodies = true
    else if (arg === "--dom-snapshots") result.domSnapshots = true
    else if (arg === "--help") {
      console.log("Usage: npm run probe:chatgpt-cdp -- [--out path] [--duration-ms N] [--capture-bodies] [--dom-snapshots]")
      process.exit(0)
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  if (result.durationMs !== undefined && (!Number.isFinite(result.durationMs) || result.durationMs <= 0)) throw new Error("--duration-ms must be > 0")
  return result
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return headers
  const redacted = {}
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = /authorization|cookie|set-cookie|token|api-key|session/i.test(key) ? "<redacted>" : value
  }
  return redacted
}

function sanitizeUrl(value) {
  if (typeof value !== "string" || !value) return value
  try {
    const url = new URL(value)
    for (const key of [...url.searchParams.keys()]) {
      if (/authorization|cookie|token|api[-_]?key|session|verify|secret|signature|sig$/i.test(key)) url.searchParams.set(key, "<redacted>")
    }
    return url.toString()
  } catch {
    return value
  }
}

function remoteObjectSummary(value) {
  return {
    type: value?.type,
    subtype: value?.subtype,
    value: value?.value,
    description: value?.description,
  }
}

function shouldCaptureBody(value) {
  return isStreamingConversationUrl(value) || isConversationHistoryUrl(value)
}

function isStreamingConversationUrl(value) {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.hostname === "chatgpt.com" && (url.pathname === "/backend-api/f/conversation" || url.pathname === "/backend-api/f/conversation/resume")
  } catch {
    return false
  }
}

function isConversationHistoryUrl(value) {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/conversations/")
  } catch {
    return false
  }
}

function decodeBase64(value) {
  if (typeof value !== "string" || value.length === 0) return undefined
  try {
    return Buffer.from(value, "base64").toString("utf8")
  } catch {
    return undefined
  }
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
