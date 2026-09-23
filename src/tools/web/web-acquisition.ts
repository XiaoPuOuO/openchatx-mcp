import { stripVTControlCharacters } from "node:util"

import type { CDPSession } from "playwright-core"
import { MCP_CONFIG } from "../../config.js"
import { type EncodedMcpImage, encodeImageForMcp } from "../image/image-encoding.js"
import { WebOpenError } from "./web-error.js"

export type WebsiteContentFormat = "markdown" | "html"

export interface AcquiredTextResource {
  kind?: "text"
  url: string
  title: string
  content: string
  status?: number
  contentType?: string
}

export interface AcquiredImageResource {
  kind: "image"
  url: string
  title: string
  status: number
  contentType?: string
  image: EncodedMcpImage
}

export type AcquiredResource = AcquiredTextResource | AcquiredImageResource

const CHARSET_PATTERN = /(?:^|;)\s*charset\s*=\s*["']?([^;"']+)/iu
const HIDDEN_STYLE_PATTERN =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/iu
const PDF_PAGE_LIMIT = 500
const CONNECTION_REFUSED_PATTERN = /^page\.goto: net::ERR_CONNECTION_REFUSED\b/u

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

export async function acquireWebResource(
  url: string,
  format: WebsiteContentFormat,
  compact: boolean,
  signal?: AbortSignal,
  resourceByteLimit = MCP_CONFIG.web.resourceByteLimit
): Promise<AcquiredResource> {
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

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The CDP Fetch handler mirrors mutually exclusive HTTP response outcomes and must resolve each paused request exactly once.
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
          await cdp.send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "Aborted",
          })
          return
        }

        if (Number.isFinite(declaredLength) && declaredLength > resourceByteLimit) {
          throw new WebOpenError(
            "resource_too_large",
            `Resource is ${declaredLength} bytes; the fetch limit is ${resourceByteLimit} bytes.`
          )
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
          await cdp.send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "Aborted",
          })
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
          await cdp.send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "Aborted",
          })
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
    let response: Awaited<ReturnType<typeof page.goto>> | undefined
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
    if (capturedResource) return await convertCapturedResource(capturedResource)

    if (navigationError) throw navigationFailure(navigationError)
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
    throw webOpenError(
      "open_failed",
      stripVTControlCharacters(error instanceof Error ? error.message : String(error)),
      error
    )
  } finally {
    await browser.close()
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

async function readBoundedCdpBody(
  cdp: CDPSession,
  requestId: string,
  resourceByteLimit: number,
  signal?: AbortSignal
): Promise<Buffer> {
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
        throw new WebOpenError(
          "resource_too_large",
          `Resource exceeds the ${resourceByteLimit} byte fetch limit.`
        )
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
  if (
    !mediaType ||
    mediaType === "application/octet-stream" ||
    mediaType === "binary/octet-stream" ||
    mediaType === "application/download"
  )
    return "generic"
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
  if (
    body.length >= 8 &&
    body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return true
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return true
  if (
    body.length >= 6 &&
    (body.subarray(0, 6).toString("ascii") === "GIF87a" ||
      body.subarray(0, 6).toString("ascii") === "GIF89a")
  )
    return true
  return (
    body.length >= 12 &&
    body.subarray(0, 4).toString("ascii") === "RIFF" &&
    body.subarray(8, 12).toString("ascii") === "WEBP"
  )
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
  const charsetMatch = CHARSET_PATTERN.exec(contentType ?? "")
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome thinks the regex match is guaranteed; TypeScript correctly treats it as nullable.
  const capturedCharset = charsetMatch?.[1]
  const detectedCharset = capturedCharset === undefined ? undefined : capturedCharset.trim()
  const charset = detectedCharset ? detectedCharset : "utf-8"
  try {
    return new TextDecoder(charset).decode(body)
  } catch {
    return new TextDecoder("utf-8").decode(body)
  }
}

async function convertCapturedResource(resource: CapturedRawResource): Promise<AcquiredResource> {
  if (resource.kind === "unsupported") {
    const contentType = resource.contentType ? resource.contentType : "unknown"
    throw new WebOpenError(
      "unsupported_content_type",
      `Unsupported content type ${contentType}. Supported resources are webpages, PDFs, images, and common text formats.`
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

async function extractPdf(body: Buffer): Promise<{ title: string; content: string }> {
  const { extractText, getDocumentProxy, getMeta } = await import("unpdf")
  const pdf = await getDocumentProxy(new Uint8Array(body))
  try {
    if (pdf.numPages > PDF_PAGE_LIMIT) {
      throw new WebOpenError(
        "resource_too_large",
        `PDF has ${pdf.numPages} pages; the fetch limit is ${PDF_PAGE_LIMIT} pages.`
      )
    }

    const [{ text }, meta] = await Promise.all([
      extractText(pdf, { mergePages: false }),
      getMeta(pdf),
    ])
    const title = typeof meta.info.Title === "string" ? meta.info.Title.trim() : ""
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

async function waitForRenderedPageToSettle(page: {
  evaluate: (expression: string) => Promise<unknown>
}): Promise<void> {
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
  body
    .querySelectorAll(
      'script, style, noscript, template, nav, footer, svg, [hidden], [aria-hidden="true"]'
    )
    .forEach((element) => {
      element.remove()
    })

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
    if (style && HIDDEN_STYLE_PATTERN.test(style)) {
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
    if (src?.startsWith("data:")) element.removeAttribute("src")
  }

  return document.documentElement?.outerHTML ?? body.outerHTML
}

function normalizeWebUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw webOpenError("invalid_url", "url must be a valid HTTP or HTTPS URL.", error)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebOpenError("invalid_url", "url must use HTTP or HTTPS.")
  }
  return url.href
}

function webOpenError(code: WebOpenError["code"], message: string, cause: unknown): WebOpenError {
  return new WebOpenError(code, message, { cause })
}

function navigationFailure(error: unknown): WebOpenError {
  const message = stripVTControlCharacters(error instanceof Error ? error.message : String(error))
  return webOpenError(
    CONNECTION_REFUSED_PATTERN.test(message) ? "connection_refused" : "open_failed",
    message,
    error
  )
}
