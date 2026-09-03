import { randomUUID } from "node:crypto"
import { stripVTControlCharacters } from "node:util"

import type { CDPSession } from "playwright-core"

import { tokenChunk } from "../../tokenizer.js"
import { MCP_CONFIG } from "../../config.js"
import { utf8Prefix } from "../../utils.js"
import { encodeImageForMcp, type EncodedMcpImage } from "../image/image-encoding.js"

type WebsiteContentFormat = "markdown" | "html"

export interface WebOpenInput {
  url: string
  format: WebsiteContentFormat
  compact: boolean
  cursor?: string
  maxOutputTokens: number
  signal?: AbortSignal
}

export interface WebOpenResult extends Record<string, unknown> {
  kind: "text" | "image"
  url: string
  title: string
  status: number
  content_type?: string
  format: WebsiteContentFormat
  compact: boolean
  content: string
  image?: EncodedMcpImage
  next_cursor?: string
  output_truncated?: true
  source_dropped?: true
  dropped_source_bytes?: number
}

interface FetchedTextResource {
  kind?: "text"
  url: string
  title: string
  content: string
  status?: number
  contentType?: string
}

interface FetchedImageResource {
  kind: "image"
  url: string
  title: string
  status: number
  contentType?: string
  image: EncodedMcpImage
}

type FetchedResource = FetchedTextResource | FetchedImageResource

export interface WebPageOpenerOptions {
  renderPage?: (
    url: string,
    format: WebsiteContentFormat,
    compact: boolean,
    signal?: AbortSignal,
    resourceByteLimit?: number
  ) => Promise<FetchedResource>
  defaultOutputTokens?: number
  maxOutputTokens?: number
  documentByteLimit?: number
  resourceByteLimit?: number
  documentTtlMs?: number
  documentLimit?: number
  now?: () => number
}

interface CachedDocument extends FetchedTextResource {
  id: string
  requestedUrl: string
  format: WebsiteContentFormat
  compact: boolean
  status: number
  expiresAt: number
  droppedSourceBytes: number
}

interface CursorPayload {
  v: 1
  documentId: string
  offset: number
}

export class WebPageOpener {
  readonly defaultOutputTokens: number
  readonly maximumOutputTokens: number

  private readonly renderPage: NonNullable<WebPageOpenerOptions["renderPage"]>
  private readonly documentByteLimit: number
  private readonly resourceByteLimit: number
  private readonly documentTtlMs: number
  private readonly documentLimit: number
  private readonly now: () => number
  private readonly documents = new Map<string, CachedDocument>()

  constructor(options: WebPageOpenerOptions = {}) {
    this.defaultOutputTokens = options.defaultOutputTokens ?? MCP_CONFIG.web.defaultOutputTokens
    this.maximumOutputTokens = options.maxOutputTokens ?? MCP_CONFIG.web.maxOutputTokens
    this.documentByteLimit = options.documentByteLimit ?? MCP_CONFIG.web.documentByteLimit
    this.resourceByteLimit = options.resourceByteLimit ?? MCP_CONFIG.web.resourceByteLimit
    this.documentTtlMs = options.documentTtlMs ?? MCP_CONFIG.web.documentTtlMs
    this.documentLimit = options.documentLimit ?? MCP_CONFIG.web.documentLimit
    this.renderPage = options.renderPage ?? renderWithCloakBrowser
    this.now = options.now ?? Date.now
  }

  async open(input: WebOpenInput): Promise<WebOpenResult> {
    const requestedUrl = input.url
    const format = input.format
    const compact = input.compact
    const maxOutputTokens = input.maxOutputTokens
    this.removeExpiredDocuments()

    let document: CachedDocument
    let offset = 0

    if (input.cursor) {
      const cursor = decodeCursor(input.cursor)
      document = this.getDocument(cursor.documentId)
      if (requestedUrl !== document.requestedUrl && requestedUrl !== document.url) {
        throw new WebOpenError("invalid_cursor", "The cursor does not belong to the requested URL.")
      }
      if (format !== document.format) {
        throw new WebOpenError("invalid_cursor", `The cursor belongs to format ${document.format}; continue with the same format.`)
      }
      if (compact !== document.compact) {
        throw new WebOpenError("invalid_cursor", `The cursor belongs to compact=${document.compact}; continue with the same compact setting.`)
      }
      offset = cursor.offset
      if (offset < 0 || offset > document.content.length) {
        throw new WebOpenError("invalid_cursor", "The cursor offset is invalid.")
      }
    } else {
      const rendered = await this.renderPage(requestedUrl, format, compact, input.signal, this.resourceByteLimit)
      if (rendered.kind === "image") {
        return {
          kind: "image",
          url: normalizeWebUrl(rendered.url),
          title: rendered.title.trim(),
          status: rendered.status,
          ...(rendered.contentType?.trim() ? { content_type: rendered.contentType.trim() } : {}),
          format,
          compact,
          content: "",
          image: rendered.image,
        }
      }
      const finalUrl = normalizeWebUrl(rendered.url)
      const boundedContent = utf8Prefix(rendered.content, this.documentByteLimit)
      document = {
        id: randomUUID(),
        requestedUrl,
        url: finalUrl,
        title: rendered.title.trim(),
        status: rendered.status ?? 200,
        ...(rendered.contentType?.trim() ? { contentType: rendered.contentType.trim() } : {}),
        format,
        compact,
        content: boundedContent.value,
        expiresAt: this.now() + this.documentTtlMs,
        droppedSourceBytes: boundedContent.omittedBytes,
      }
      this.storeDocument(document)
    }

    const chunk = tokenChunk(document.content, offset, maxOutputTokens)
    const result: WebOpenResult = {
      kind: "text",
      url: document.url,
      title: document.title,
      status: document.status,
      ...(document.contentType ? { content_type: document.contentType } : {}),
      format: document.format,
      compact: document.compact,
      content: chunk.value,
    }
    if (chunk.nextOffset < document.content.length) {
      result.next_cursor = encodeCursor({
        v: 1,
        documentId: document.id,
        offset: chunk.nextOffset,
      })
      result.output_truncated = true
    }
    if (document.droppedSourceBytes > 0) {
      result.source_dropped = true
      result.dropped_source_bytes = document.droppedSourceBytes
    }
    return result
  }

  private getDocument(id: string): CachedDocument {
    const document = this.documents.get(id)
    if (!document || document.expiresAt <= this.now()) {
      if (document) this.documents.delete(id)
      throw new WebOpenError("cursor_expired", "The cursor has expired. Open the page again without a cursor.")
    }

    this.documents.delete(id)
    this.documents.set(id, document)
    return document
  }

  private storeDocument(document: CachedDocument): void {
    this.documents.set(document.id, document)
    while (this.documents.size > this.documentLimit) {
      const oldestId = this.documents.keys().next().value as string | undefined
      if (!oldestId) break
      this.documents.delete(oldestId)
    }
  }

  private removeExpiredDocuments(): void {
    const now = this.now()
    for (const [id, document] of this.documents) {
      if (document.expiresAt <= now) this.documents.delete(id)
    }
  }
}

export class WebOpenError extends Error {
  constructor(
    readonly code: "invalid_url" | "invalid_cursor" | "cursor_expired" | "open_failed" | "resource_too_large" | "unsupported_content_type",
    message: string
  ) {
    super(message)
    this.name = "WebOpenError"
  }
}

type CapturedResourceKind = "pdf" | "image" | "text" | "unsupported"
type MediaKind = "html" | CapturedResourceKind | "generic"

interface CapturedRawResource {
  kind: CapturedResourceKind
  url: string
  status: number
  contentType?: string
  body: Buffer
}

interface CdpFetchHeader {
  name: string
  value: string
}

interface CdpFetchRequestPaused {
  requestId: string
  request: { url: string }
  frameId?: string
  resourceType?: string
  responseStatusCode?: number
  responseHeaders?: CdpFetchHeader[]
}

async function renderWithCloakBrowser(
  url: string,
  format: WebsiteContentFormat,
  compact: boolean,
  signal?: AbortSignal,
  resourceByteLimit = MCP_CONFIG.web.resourceByteLimit
): Promise<FetchedResource> {
  if (signal?.aborted) {
    throw new WebOpenError("open_failed", "The web request was aborted.")
  }

  const { launch } = await import("cloakbrowser")

  // Deliberately launch per fetch: web reads are infrequent, and startup cost is preferable to keeping a background Chromium process alive.
  const browser = await launch({ headless: true })
  try {
    const page = await browser.newPage()
    const cdp = await page.context().newCDPSession(page)
    const frameTree = await cdp.send("Page.getFrameTree")
    const mainFrameId = frameTree.frameTree.frame.id
    let capturedResource: CapturedRawResource | undefined
    let capturedError: unknown
    let captureTask: Promise<void> | undefined

    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Response" }],
    })
    cdp.on("Fetch.requestPaused", (event) => {
      const task = handlePausedResponse(event)
      captureTask = task
      void task.catch(() => undefined)
    })

    async function handlePausedResponse(event: CdpFetchRequestPaused): Promise<void> {
      try {
        if (!event.responseStatusCode) {
          await cdp.send("Fetch.continueRequest", { requestId: event.requestId })
          return
        }
        if (event.frameId !== mainFrameId || event.resourceType !== "Document") {
          await cdp.send("Fetch.continueResponse", { requestId: event.requestId })
          return
        }

        const headers = cdpHeaders(event.responseHeaders ?? [])
        const status = event.responseStatusCode
        const contentType = headers.get("content-type")?.trim()
        if (isRedirectStatus(status)) {
          await cdp.send("Fetch.continueResponse", { requestId: event.requestId })
          return
        }

        const declaredLength = Number(headers.get("content-length"))
        if (status === 204 || status === 205 || declaredLength === 0) {
          capturedResource = {
            kind: "text",
            url: event.request.url,
            status,
            ...(contentType ? { contentType } : {}),
            body: Buffer.alloc(0),
          }
          await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" })
          return
        }

        if (Number.isFinite(declaredLength) && declaredLength > resourceByteLimit) {
          throw new WebOpenError("resource_too_large", `Resource is ${declaredLength} bytes; the fetch limit is ${resourceByteLimit} bytes.`)
        }

        const mediaKind = classifyMediaType(normalizedMediaType(contentType))
        if (mediaKind === "html") {
          await cdp.send("Fetch.continueResponse", { requestId: event.requestId })
          return
        }
        if (mediaKind === "unsupported") {
          capturedResource = {
            kind: "unsupported",
            url: event.request.url,
            status,
            ...(contentType ? { contentType } : {}),
            body: Buffer.alloc(0),
          }
          await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" })
          return
        }

        const body = await readBoundedCdpBody(cdp, event.requestId, resourceByteLimit, signal)
        const kind = mediaKind === "generic" ? sniffGenericResource(body) : mediaKind
        if (kind === "html") {
          await cdp.send("Fetch.fulfillRequest", {
            requestId: event.requestId,
            responseCode: status,
            responseHeaders: event.responseHeaders,
            body: body.toString("base64"),
          })
          return
        }

        capturedResource = {
          kind,
          url: event.request.url,
          status,
          ...(contentType ? { contentType } : {}),
          body,
        }
        await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" })
      } catch (error) {
        capturedError = error
        try {
          await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" })
        } catch {
          // The request may already be resolved after a streaming failure.
        }
      }
    }

    await page.route("**/*", async (route) => {
      const resourceType = route.request().resourceType()
      if (resourceType === "image" || resourceType === "media" || resourceType === "font") {
        await route.abort()
        return
      }
      await route.continue()
    })
    let response
    let navigationError: unknown
    try {
      response = await page.goto(url, {
        waitUntil: "commit",
        timeout: 30_000,
      })
    } catch (error) {
      navigationError = error
    }

    if (captureTask) await captureTask
    if (capturedError) throw capturedError
    if (capturedResource) {
      return await convertCapturedResource(capturedResource)
    }

    if (navigationError) throw navigationError
    if (!response) throw new Error("Navigation completed without an HTTP response.")

    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 })
    await waitForRenderedPageToSettle(page)

    if (signal?.aborted) throw new WebOpenError("open_failed", "The web request was aborted.")

    const finalUrl = page.url()
    const browserTitle = await page.title()
    const html = await page.content()
    const outputHtml = compact ? await compactRenderedHtml(html) : html
    const status = response.status()
    const contentType = response.headers()["content-type"]?.trim()

    if (format === "html") {
      return {
        url: finalUrl,
        title: browserTitle,
        content: outputHtml,
        status,
        ...(contentType ? { contentType } : {}),
      }
    }

    const { NodeHtmlMarkdown } = await import("node-html-markdown")
    return {
      url: finalUrl,
      title: browserTitle,
      content: NodeHtmlMarkdown.translate(outputHtml),
      status,
      ...(contentType ? { contentType } : {}),
    }
  } catch (error) {
    if (error instanceof WebOpenError) throw error
    throw new WebOpenError("open_failed", stripVTControlCharacters(error instanceof Error ? error.message : String(error)))
  } finally {
    await browser.close()
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

async function readBoundedCdpBody(cdp: CDPSession, requestId: string, resourceByteLimit: number, signal?: AbortSignal): Promise<Buffer> {
  const { stream } = await cdp.send("Fetch.takeResponseBodyAsStream", { requestId })
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    for (;;) {
      if (signal?.aborted) throw new WebOpenError("open_failed", "The web request was aborted.")
      const result = await cdp.send("IO.read", { handle: stream, size: 64 * 1024 })
      const chunk = Buffer.from(result.data, result.base64Encoded ? "base64" : "utf8")
      totalBytes += chunk.byteLength
      if (totalBytes > resourceByteLimit) {
        throw new WebOpenError("resource_too_large", `Resource exceeds the ${resourceByteLimit} byte fetch limit.`)
      }
      if (chunk.length > 0) chunks.push(chunk)
      if (result.eof) break
    }
  } finally {
    await cdp.send("IO.close", { handle: stream }).catch(() => undefined)
  }
  return Buffer.concat(chunks, totalBytes)
}

function cdpHeaders(headers: readonly CdpFetchHeader[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const header of headers) result.set(header.name.toLowerCase(), header.value)
  return result
}

function normalizedMediaType(contentType?: string): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

function isHtmlMediaType(mediaType: string): boolean {
  return mediaType === "text/html" || mediaType === "application/xhtml+xml"
}

function classifyMediaType(mediaType: string): MediaKind {
  if (isHtmlMediaType(mediaType)) return "html"
  if (mediaType === "application/pdf") return "pdf"
  if (mediaType.startsWith("image/")) return "image"
  if (isTextMediaType(mediaType)) return "text"
  if (!mediaType || mediaType === "application/octet-stream" || mediaType === "binary/octet-stream" || mediaType === "application/download") return "generic"
  return "unsupported"
}

function sniffGenericResource(body: Buffer): CapturedResourceKind | "html" {
  if (body.subarray(0, 1024).includes(Buffer.from("%PDF-"))) return "pdf"
  if (hasImageSignature(body)) return "image"
  if (looksLikeHtml(body)) return "html"
  if (looksLikeText(body)) return "text"
  return "unsupported"
}

function hasImageSignature(body: Buffer): boolean {
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return true
  if (body.length >= 6 && (body.subarray(0, 6).toString("ascii") === "GIF87a" || body.subarray(0, 6).toString("ascii") === "GIF89a")) return true
  return body.length >= 12 && body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP"
}

function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json") ||
    mediaType === "application/xml" ||
    mediaType.endsWith("+xml") ||
    mediaType === "application/javascript" ||
    mediaType === "application/x-javascript" ||
    mediaType === "application/x-www-form-urlencoded" ||
    mediaType === "application/yaml" ||
    mediaType === "application/x-yaml"
  )
}

function looksLikeHtml(body: Buffer): boolean {
  const prefix = body.subarray(0, 4096).toString("utf8").trimStart().toLowerCase()
  return prefix.startsWith("<!doctype html") || prefix.startsWith("<html")
}

function looksLikeText(body: Buffer): boolean {
  const sample = body.subarray(0, Math.min(body.length, 4096))
  if (sample.length === 0) return true
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample)
  } catch {
    return false
  }
  for (const byte of sample) {
    if (byte === 0) return false
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return false
  }
  return true
}

function decodeTextResource(body: Buffer, contentType?: string): string {
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"']+)/i.exec(contentType ?? "")?.[1]?.trim() || "utf-8"
  try {
    return new TextDecoder(charset).decode(body)
  } catch {
    return new TextDecoder("utf-8").decode(body)
  }
}

async function convertCapturedResource(resource: CapturedRawResource): Promise<FetchedResource> {
  if (resource.kind === "unsupported") {
    throw new WebOpenError(
      "unsupported_content_type",
      `Unsupported content type ${resource.contentType || "unknown"}. Supported resources are webpages, PDFs, images, and common text formats.`
    )
  }

  const finalUrl = normalizeWebUrl(resource.url)
  const fallbackTitle = titleFromUrl(finalUrl)
  if (resource.kind === "pdf") {
    const extracted = await extractPdf(resource.body)
    return {
      url: finalUrl,
      title: extracted.title || fallbackTitle,
      content: extracted.content,
      status: resource.status,
      ...(resource.contentType ? { contentType: resource.contentType } : {}),
    }
  }
  if (resource.kind === "image") {
    return {
      kind: "image",
      url: finalUrl,
      title: fallbackTitle,
      status: resource.status,
      ...(resource.contentType ? { contentType: resource.contentType } : {}),
      image: await encodeImageForMcp(resource.body),
    }
  }
  return {
    url: finalUrl,
    title: fallbackTitle,
    content: decodeTextResource(resource.body, resource.contentType),
    status: resource.status,
    ...(resource.contentType ? { contentType: resource.contentType } : {}),
  }
}

const PDF_PAGE_LIMIT = 500

async function extractPdf(body: Buffer): Promise<{ title: string; content: string }> {
  const { extractText, getDocumentProxy, getMeta } = await import("unpdf")
  const pdf = await getDocumentProxy(new Uint8Array(body))
  try {
    if (pdf.numPages > PDF_PAGE_LIMIT) {
      throw new WebOpenError("resource_too_large", `PDF has ${pdf.numPages} pages; the fetch limit is ${PDF_PAGE_LIMIT} pages.`)
    }

    const [{ text }, meta] = await Promise.all([extractText(pdf, { mergePages: false }), getMeta(pdf)])
    const title = typeof meta.info["Title"] === "string" ? meta.info["Title"].trim() : ""
    const content = text.map((page, index) => `## Page ${index + 1}\n\n${page.trim()}`).join("\n\n")
    return { title, content }
  } finally {
    await pdf.loadingTask.destroy()
  }
}

function titleFromUrl(value: string): string {
  const url = new URL(value)
  const segment = url.pathname.split("/").filter(Boolean).at(-1)
  if (!segment) return url.hostname
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

async function waitForRenderedPageToSettle(page: { evaluate: (expression: string) => Promise<unknown> }): Promise<void> {
  await page.evaluate(`new Promise((resolve) => {
    const startedAt = performance.now();
    let lastMutationAt = startedAt;
    const observer = new MutationObserver(() => lastMutationAt = performance.now());
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const interval = setInterval(() => {
      const now = performance.now();
      if ((now - startedAt >= 2000 && now - lastMutationAt >= 300) || now - startedAt >= 5000) {
        clearInterval(interval);
        observer.disconnect();
        resolve(undefined);
      }
    }, 50);
  })`)
}

async function compactRenderedHtml(html: string): Promise<string> {
  const { parseHTML } = await import("linkedom")
  const { document } = parseHTML(html)
  const body = document.body
  if (!body) return ""

  document.querySelector("head")?.remove()
  body.querySelectorAll('script, style, noscript, template, nav, footer, svg, [hidden], [aria-hidden="true"]').forEach((element) => element.remove())

  const hiddenStyle = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/i
  const strippedAttributes = new Set([
    "class",
    "style",
    "srcset",
    "sizes",
    "width",
    "height",
    "loading",
    "decoding",
    "fetchpriority",
  ])

  for (const element of document.querySelectorAll("*")) {
    const style = element.getAttribute("style")
    if (style && hiddenStyle.test(style)) {
      element.remove()
      continue
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (strippedAttributes.has(name) || name.startsWith("data-") || name.startsWith("on")) {
        element.removeAttribute(attribute.name)
      }
    }

    const src = element.getAttribute("src")
    if (src?.startsWith("data:")) {
      element.removeAttribute("src")
    }
  }

  return document.documentElement?.outerHTML ?? body.outerHTML
}

function normalizeWebUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WebOpenError("invalid_url", "url must be a valid HTTP or HTTPS URL.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebOpenError("invalid_url", "url must use HTTP or HTTPS.")
  }
  return url.href
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
}

function decodeCursor(value: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorPayload>
    if (
      parsed.v !== 1 ||
      typeof parsed.documentId !== "string" ||
      parsed.documentId.length === 0 ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0
    ) {
      throw new Error("invalid cursor payload")
    }
    return parsed as CursorPayload
  } catch {
    throw new WebOpenError("invalid_cursor", "cursor is invalid.")
  }
}
