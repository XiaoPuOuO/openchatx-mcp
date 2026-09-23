import { randomUUID } from "node:crypto"

import { MCP_CONFIG } from "../../config.js"
import { tokenChunk } from "../../tokenizer.js"
import { asRecord, utf8Prefix } from "../../utils.js"
import type { EncodedMcpImage } from "../image/image-encoding.js"
import {
  type AcquiredResource,
  type AcquiredTextResource,
  acquireWebResource,
  type WebsiteContentFormat,
} from "./web-acquisition.js"
import { WebOpenError } from "./web-error.js"

export { WebOpenError }

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

export interface WebPageOpenerOptions {
  renderPage?: (
    url: string,
    format: WebsiteContentFormat,
    compact: boolean,
    signal?: AbortSignal,
    resourceByteLimit?: number
  ) => Promise<AcquiredResource>
  defaultOutputTokens?: number
  maxOutputTokens?: number
  documentByteLimit?: number
  resourceByteLimit?: number
  documentTtlMs?: number
  documentLimit?: number
  now?: () => number
}

interface CachedDocument extends AcquiredTextResource {
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
    this.renderPage = options.renderPage ?? acquireWebResource
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
      const resumed = this.resumeDocument(input.cursor, requestedUrl, format, compact)
      document = resumed.document
      offset = resumed.offset
    } else {
      const rendered = await this.renderPage(
        requestedUrl,
        format,
        compact,
        input.signal,
        this.resourceByteLimit
      )
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
      throw new WebOpenError(
        "cursor_expired",
        "The cursor has expired. Open the page again without a cursor."
      )
    }

    this.documents.delete(id)
    this.documents.set(id, document)
    return document
  }

  private resumeDocument(
    cursorValue: string,
    requestedUrl: string,
    format: WebsiteContentFormat,
    compact: boolean
  ): { document: CachedDocument; offset: number } {
    const cursor = decodeCursor(cursorValue)
    const document = this.getDocument(cursor.documentId)
    if (requestedUrl !== document.requestedUrl && requestedUrl !== document.url) {
      throw new WebOpenError("invalid_cursor", "The cursor does not belong to the requested URL.")
    }
    if (format !== document.format) {
      throw new WebOpenError(
        "invalid_cursor",
        `The cursor belongs to format ${document.format}; continue with the same format.`
      )
    }
    if (compact !== document.compact) {
      throw new WebOpenError(
        "invalid_cursor",
        `The cursor belongs to compact=${document.compact}; continue with the same compact setting.`
      )
    }
    if (cursor.offset < 0 || cursor.offset > document.content.length) {
      throw new WebOpenError("invalid_cursor", "The cursor offset is invalid.")
    }
    return { document, offset: cursor.offset }
  }

  private storeDocument(document: CachedDocument): void {
    this.documents.set(document.id, document)
    while (this.documents.size > this.documentLimit) {
      const oldest = this.documents.keys().next()
      if (oldest.done) break
      this.documents.delete(oldest.value)
    }
  }

  private removeExpiredDocuments(): void {
    const now = this.now()
    for (const [id, document] of this.documents) {
      if (document.expiresAt <= now) this.documents.delete(id)
    }
  }
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

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
}

function decodeCursor(value: string): CursorPayload {
  try {
    const parsed = asRecord(JSON.parse(Buffer.from(value, "base64url").toString("utf8")))
    if (
      parsed?.v !== 1 ||
      typeof parsed.documentId !== "string" ||
      parsed.documentId.length === 0 ||
      typeof parsed.offset !== "number" ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new Error("invalid cursor payload")
    }
    return { v: 1, documentId: parsed.documentId, offset: parsed.offset }
  } catch (error) {
    throw webOpenError("invalid_cursor", "cursor is invalid.", error)
  }
}

function webOpenError(code: WebOpenError["code"], message: string, cause: unknown): WebOpenError {
  return new WebOpenError(code, message, { cause })
}
