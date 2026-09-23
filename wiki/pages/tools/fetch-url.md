---
summary: "Browser-backed fetch_url handling for HTML, PDFs, images, raw resources, and retained document pagination."
paths:
  - src/tools/web/
  - src/tools/image/image-encoding.ts
  - src/config.ts
  - src/tokenizer.ts
  - test/web-fetch.test.ts
---

# fetch_url

`web-tool.ts` owns the MCP contract. `web-acquisition.ts` is the deep acquisition boundary for browser launch/cleanup, CDP response interception, MIME dispatch, and HTML/PDF/image/text conversion. `web-open.ts` owns retained text documents, cursor validation, TTL/LRU retention, byte bounding, and token pagination. Production creates one `WebPageOpener` when web tools are enabled.

## Resource Handling

HTML uses the CloakBrowser render path and can return Markdown, cleaned HTML, or raw rendered HTML. Non-HTML interception streams the original Chromium response once, preserving browser cookies and redirects rather than refetching through another HTTP client.

- PDFs use `unpdf` text extraction with page headings. PDFs above the page-count ceiling are rejected before extraction; otherwise extraction completes before the shared cached-document byte cap is applied. Large extracted text can therefore require transient memory beyond retained-document size.
- Images use the shared Sharp encoder and return native image content.
- Text, JSON, XML, JavaScript, form, and YAML media types decode as text without reparsing values.
- Unsupported binary types fail explicitly.
- Empty 204/205 responses and declared zero-length responses retain HTTP metadata, including bodyless HTTP errors Chromium would otherwise treat as failed navigation.

## Retention and Pagination

Raw non-HTML bodies have a separate byte ceiling from extracted text documents. Text documents are process-local and bounded by size, count, and TTL in `MCP_CONFIG.web`; these remain code-owned limits. Cursors address retained documents. Cursor reads tokenize a bounded local character window, so unusually compressible text can return less than the requested token ceiling while pagination still reconstructs retained content.

Fetching retains the host's network authority, including access to local/private services. It is not an isolated remote fetch service. A headless browser render can behave differently from the authenticated dedicated ChatGPT Chrome; the two browser lifecycles are separate.

## Related

- [MCP Tool Surface](../mcp-tool-surface.md)
- [Open Questions and Risks](../project/open-questions-and-risks.md)
