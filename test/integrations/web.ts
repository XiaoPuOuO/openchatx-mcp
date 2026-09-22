import assert from "node:assert/strict"
import { createServer } from "node:http"
import process from "node:process"
import test from "node:test"
import sharp from "sharp"
import { WebOpenError, WebPageOpener } from "../../src/tools/web/web-open.js"
import { compactField, connectClient, startMcpHttpServer, toolText } from "./helpers.js"

const LIVE_WEB_TEST_ENABLED = process.env.RUN_LIVE_WEB_TESTS === "1" && !process.env.CI
const liveWebTest = LIVE_WEB_TEST_ENABLED ? test : test.skip

liveWebTest(
  "renders a real localhost page through the default web stack",
  { timeout: 60_000 },
  async (t) => {
    const pageServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(
        "<!doctype html><html><head><title>Integration Test</title></head><body><main><h1>Hello MCP</h1><p>Real browser rendering works.</p></main></body></html>"
      )
    })
    await new Promise<void>((resolve, reject) => {
      pageServer.once("error", reject)
      pageServer.listen(0, "127.0.0.1", resolve)
    })
    t.after(async () => {
      await new Promise<void>((resolve) => pageServer.close(() => resolve()))
    })

    const address = pageServer.address()
    assert.ok(address && typeof address !== "string")

    const running = await startMcpHttpServer()
    t.after(() => running.close())
    const connected = await connectClient(running.url, "fetch-url-real-render-client")
    t.after(() => connected.client.close())

    const result = await connected.client.callTool({
      name: "fetch_url",
      arguments: {
        url: `http://127.0.0.1:${address.port}/`,
        format: "markdown",
      },
    })

    assert.equal(result.isError, undefined)
    assert.equal(result.structuredContent, undefined)
    const resultText = toolText(result)
    assert.equal(compactField(resultText, "title"), "Integration Test")
    assert.equal(compactField(resultText, "status"), "200")
    assert.equal(compactField(resultText, "content_type"), "text/html; charset=utf-8")
    assert.match(compactField(resultText, "content") ?? "", /Hello MCP/u)
    assert.match(compactField(resultText, "content") ?? "", /Real browser rendering works\./u)
  }
)

liveWebTest(
  "returns successful empty responses with HTTP metadata",
  { timeout: 60_000 },
  async (t) => {
    const pageServer = createServer((request, response) => {
      if (request.url === "/reset") {
        response.writeHead(205, { "content-type": "text/plain; charset=utf-8" })
        response.end()
        return
      }
      response.writeHead(204)
      response.end()
    })
    await new Promise<void>((resolve, reject) => {
      pageServer.once("error", reject)
      pageServer.listen(0, "127.0.0.1", resolve)
    })
    t.after(async () => {
      await new Promise<void>((resolve) => pageServer.close(() => resolve()))
    })

    const address = pageServer.address()
    assert.ok(address && typeof address !== "string")
    const opener = new WebPageOpener()

    const noContent = await opener.open({
      url: `http://127.0.0.1:${address.port}/no-content`,
      format: "markdown",
      compact: false,
      maxOutputTokens: opener.maximumOutputTokens,
    })
    assert.equal(noContent.status, 204)
    assert.equal(noContent.content, "")
    assert.equal(noContent.url, `http://127.0.0.1:${address.port}/no-content`)

    const reset = await opener.open({
      url: `http://127.0.0.1:${address.port}/reset`,
      format: "markdown",
      compact: false,
      maxOutputTokens: opener.maximumOutputTokens,
    })
    assert.equal(reset.status, 205)
    assert.equal(reset.content_type, "text/plain; charset=utf-8")
    assert.equal(reset.content, "")
  }
)

liveWebTest(
  "returns bodyless HTTP errors with metadata instead of navigation failures",
  { timeout: 60_000 },
  async (t) => {
    const pageServer = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/missing" })
        response.end()
        return
      }
      const status = request.url === "/missing" ? 404 : 500
      response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "content-length": "0",
      })
      response.end()
    })
    await new Promise<void>((resolve, reject) => {
      pageServer.once("error", reject)
      pageServer.listen(0, "127.0.0.1", resolve)
    })
    t.after(async () => {
      await new Promise<void>((resolve) => pageServer.close(() => resolve()))
    })

    const address = pageServer.address()
    assert.ok(address && typeof address !== "string")
    const opener = new WebPageOpener()
    const base = `http://127.0.0.1:${address.port}`

    const missing = await opener.open({
      url: `${base}/redirect`,
      format: "markdown",
      compact: true,
      maxOutputTokens: opener.maximumOutputTokens,
    })
    assert.equal(missing.status, 404)
    assert.equal(missing.url, `${base}/missing`)
    assert.equal(missing.content_type, "text/html; charset=utf-8")
    assert.equal(missing.content, "")

    const failed = await opener.open({
      url: `${base}/failed`,
      format: "markdown",
      compact: true,
      maxOutputTokens: opener.maximumOutputTokens,
    })
    assert.equal(failed.status, 500)
    assert.equal(failed.url, `${base}/failed`)
    assert.equal(failed.content_type, "text/html; charset=utf-8")
    assert.equal(failed.content, "")
  }
)

liveWebTest(
  "waits for delayed client rendering beyond one second",
  { timeout: 60_000 },
  async (t) => {
    const pageServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(`<!doctype html><html><head><title>Delayed</title></head><body><main><p>Initial</p></main><script>
      setTimeout(() => document.querySelector('main').insertAdjacentHTML('beforeend', '<p>Delayed render captured</p>'), 1500)
    </script></body></html>`)
    })
    await new Promise<void>((resolve, reject) => {
      pageServer.once("error", reject)
      pageServer.listen(0, "127.0.0.1", resolve)
    })
    t.after(async () => {
      await new Promise<void>((resolve) => pageServer.close(() => resolve()))
    })

    const address = pageServer.address()
    assert.ok(address && typeof address !== "string")
    const opener = new WebPageOpener()
    const result = await opener.open({
      url: `http://127.0.0.1:${address.port}/`,
      format: "markdown",
      compact: false,
      maxOutputTokens: opener.maximumOutputTokens,
    })

    assert.equal(result.status, 200)
    assert.equal(result.content_type, "text/html; charset=utf-8")
    assert.match(result.content, /Delayed render captured/u)
  }
)

test("continues one cached website across MCP client sessions", { timeout: 20_000 }, async (t) => {
  const expected = "🙂".repeat(200)
  let renders = 0
  const webPageOpener = new WebPageOpener({
    renderPage: async () => {
      renders += 1
      return {
        url: "https://example.com/final",
        title: "Example page",
        content: expected,
      }
    },
  })
  const running = await startMcpHttpServer({ webPageOpener })
  t.after(() => running.close())

  const first = await connectClient(running.url, "fetch-url-client-1")
  const firstResult = await first.client.callTool({
    name: "fetch_url",
    arguments: {
      url: "https://example.com/start",
      format: "html",
      compact: false,
      max_output_tokens: 64,
    },
  })
  assert.equal(firstResult.isError, undefined)
  const firstText = toolText(firstResult)
  const firstContent = compactField(firstText, "content") ?? ""
  const nextCursor = compactField(firstText, "next_cursor")
  assert.equal(compactField(firstText, "url"), "https://example.com/final")
  assert.ok(nextCursor)
  await first.client.close()

  const second = await connectClient(running.url, "fetch-url-client-2")
  t.after(() => second.client.close())
  const secondResult = await second.client.callTool({
    name: "fetch_url",
    arguments: {
      url: "https://example.com/start",
      format: "html",
      compact: false,
      cursor: nextCursor,
      max_output_tokens: 256,
    },
  })
  assert.equal(secondResult.isError, undefined)
  const secondText = toolText(secondResult)
  const secondContent = compactField(secondText, "content") ?? ""
  assert.equal(firstContent + secondContent, expected)
  assert.equal(compactField(secondText, "next_cursor"), undefined)
  assert.equal(renders, 1)
})

liveWebTest("compact only removes explicit token-heavy markup", { timeout: 60_000 }, async (t) => {
  const pageServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html>
      <html class="root-class">
        <head><title>Full Page</title><style>.paint { color: blue; }</style><script>window.headNoise = true</script></head>
        <body class="page" data-page="reviews" style="margin:0">
          <nav>Site Navigation</nav>
          <main class="paint" data-controller="reviews">
            <h1>Customer Reviews</h1>
            <article>
              <p>Customer review body survives.</p>
              <div class="review-reply">
                <strong>Reply from business</strong>
                <div class="card-text">Owner reply should survive.</div>
              </div>
            </article>
            <aside>Sidebar details should survive.</aside>
            <table><tr><th>Service</th><th>Warranty</th></tr><tr><td>Painting</td><td>1 year</td></tr></table>
            <img alt="House" src="data:image/png;base64,AAAA" srcset="one.jpg 1x, two.jpg 2x" sizes="100vw" width="800" height="600" loading="lazy">
            <button onclick="doThing()">Useful button</button>
            <svg viewBox="0 0 10 10"><path d="M0 0h10v10z"></path></svg>
            <div aria-hidden="true">ARIA hidden detail</div>
            <div hidden>Hidden detail</div>
            <div style="display:none">Inline hidden detail</div>
            <script>window.bodyNoise = true</script>
          </main>
          <footer>Site Footer</footer>
        </body>
      </html>`)
  })
  await new Promise<void>((resolve, reject) => {
    pageServer.once("error", reject)
    pageServer.listen(0, "127.0.0.1", resolve)
  })
  t.after(async () => {
    await new Promise<void>((resolve) => pageServer.close(() => resolve()))
  })

  const address = pageServer.address()
  assert.ok(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}/reviews`
  const opener = new WebPageOpener()

  const fullHtml = await opener.open({
    url,
    format: "html",
    compact: false,
    maxOutputTokens: opener.maximumOutputTokens,
  })
  assert.match(fullHtml.content, /<head>/u)
  assert.match(fullHtml.content, /Site Navigation/u)
  assert.match(fullHtml.content, /Site Footer/u)
  assert.match(fullHtml.content, /class="card-text"/u)
  assert.match(fullHtml.content, /srcset=/u)
  assert.match(fullHtml.content, /data:image\/png;base64,AAAA/u)
  assert.match(fullHtml.content, /<svg/u)
  assert.match(fullHtml.content, /window\.bodyNoise/u)

  const compactHtml = await opener.open({
    url,
    format: "html",
    compact: true,
    maxOutputTokens: opener.maximumOutputTokens,
  })
  assert.doesNotMatch(compactHtml.content, /<head/u)
  assert.doesNotMatch(compactHtml.content, /<nav/u)
  assert.doesNotMatch(compactHtml.content, /<footer/u)
  assert.doesNotMatch(compactHtml.content, /<script/u)
  assert.doesNotMatch(compactHtml.content, /<style/u)
  assert.doesNotMatch(compactHtml.content, /<svg/u)
  assert.doesNotMatch(compactHtml.content, /class=/u)
  assert.doesNotMatch(compactHtml.content, /style=/u)
  assert.doesNotMatch(compactHtml.content, /data-controller=/u)
  assert.doesNotMatch(compactHtml.content, /onclick=/u)
  assert.doesNotMatch(compactHtml.content, /srcset=/u)
  assert.doesNotMatch(compactHtml.content, /sizes=/u)
  assert.doesNotMatch(compactHtml.content, /width=/u)
  assert.doesNotMatch(compactHtml.content, /height=/u)
  assert.doesNotMatch(compactHtml.content, /loading=/u)
  assert.doesNotMatch(compactHtml.content, /data:image/u)
  assert.doesNotMatch(compactHtml.content, /ARIA hidden detail|Hidden detail|Inline hidden detail/u)
  assert.match(compactHtml.content, /Owner reply should survive\./u)
  assert.match(compactHtml.content, /Sidebar details should survive\./u)
  assert.match(compactHtml.content, /Useful button/u)
  assert.match(compactHtml.content, /<table>/u)

  const compactMarkdown = await opener.open({
    url,
    format: "markdown",
    compact: true,
    maxOutputTokens: opener.maximumOutputTokens,
  })
  assert.match(compactMarkdown.content, /Owner reply should survive\./u)
  assert.match(compactMarkdown.content, /Sidebar details should survive\./u)
  assert.match(compactMarkdown.content, /\| Service\s+\| Warranty\s+\|/u)
  assert.doesNotMatch(
    compactMarkdown.content,
    /Site Navigation|Site Footer|ARIA hidden detail|Hidden detail|Inline hidden detail/u
  )
})

liveWebTest(
  "extracts PDF text and decodes common text resources",
  { timeout: 60_000 },
  async (t) => {
    const pdf = createTextPdf("PDF extraction works")
    const pageServer = createServer((request, response) => {
      if (request.url === "/guide.pdf") {
        response.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length })
        response.end(pdf)
        return
      }
      if (request.url === "/broken.json") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" })
        response.end('{"broken":')
        return
      }
      if (request.url === "/looks-like-pdf.txt") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        response.end("plain text containing %PDF- inside the first kilobyte")
        return
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" })
      response.end('{"ok":true,"source":"fetch_url","id":9007199254740993}')
    })
    await new Promise<void>((resolve, reject) => {
      pageServer.once("error", reject)
      pageServer.listen(0, "127.0.0.1", resolve)
    })
    t.after(async () => {
      await new Promise<void>((resolve) => pageServer.close(() => resolve()))
    })

    const address = pageServer.address()
    assert.ok(address && typeof address !== "string")
    const opener = new WebPageOpener()

    const json = await opener.open({
      url: `http://127.0.0.1:${address.port}/data.json`,
      format: "markdown",
      compact: false,
      maxOutputTokens: opener.maximumOutputTokens,
    })
    assert.equal(json.kind, "text")
    assert.equal(json.content_type, "application/json; charset=utf-8")
    assert.equal(json.content, '{"ok":true,"source":"fetch_url","id":9007199254740993}')

    const malformedJson = await opener.open({
      url: `http://127.0.0.1:${address.port}/broken.json`,
      format: "markdown",
      compact: false,
      maxOutputTokens: opener.maximumOutputTokens,
    })
    assert.equal(malformedJson.content, '{"broken":')

    const textContainingPdfMagic = await opener.open({
      url: `http://127.0.0.1:${address.port}/looks-like-pdf.txt`,
      format: "markdown",
      compact: false,
      maxOutputTokens: opener.maximumOutputTokens,
    })
    assert.equal(
      textContainingPdfMagic.content,
      "plain text containing %PDF- inside the first kilobyte"
    )

    const extractedPdf = await opener.open({
      url: `http://127.0.0.1:${address.port}/guide.pdf`,
      format: "markdown",
      compact: false,
      maxOutputTokens: opener.maximumOutputTokens,
    })
    assert.equal(extractedPdf.kind, "text")
    assert.equal(extractedPdf.content_type, "application/pdf")
    assert.match(extractedPdf.content, /^## Page 1/mu)
    assert.match(extractedPdf.content, /PDF extraction works/u)
  }
)

liveWebTest(
  "returns direct image URLs as native MCP image content",
  { timeout: 60_000 },
  async (t) => {
    const image = await sharp({
      create: { width: 32, height: 16, channels: 3, background: { r: 20, g: 40, b: 60 } },
    })
      .png()
      .toBuffer()
    const pageServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "image/png", "content-length": image.length })
      response.end(image)
    })
    await new Promise<void>((resolve, reject) => {
      pageServer.once("error", reject)
      pageServer.listen(0, "127.0.0.1", resolve)
    })
    t.after(async () => {
      await new Promise<void>((resolve) => pageServer.close(() => resolve()))
    })

    const address = pageServer.address()
    assert.ok(address && typeof address !== "string")
    const running = await startMcpHttpServer()
    t.after(() => running.close())
    const connected = await connectClient(running.url, "fetch-url-image-client")
    t.after(() => connected.client.close())

    const result = await connected.client.callTool({
      name: "fetch_url",
      arguments: { url: `http://127.0.0.1:${address.port}/pixel.png` },
    })
    assert.equal(result.isError, undefined)
    const imageBlock = result.content.find((item) => item.type === "image")
    assert.ok(imageBlock && imageBlock.type === "image")
    assert.equal(imageBlock.mimeType, "image/jpeg")
    assert.ok(imageBlock.data.length > 0)
    assert.equal(result.structuredContent, undefined)
    const resultText = toolText(result)
    assert.equal(compactField(resultText, "url"), `http://127.0.0.1:${address.port}/pixel.png`)
    assert.equal(compactField(resultText, "title"), "pixel.png")
    assert.equal(compactField(resultText, "status"), "200")
    assert.equal(compactField(resultText, "content_type"), "image/png")
    assert.equal(compactField(resultText, "content"), "")
  }
)

liveWebTest(
  "preserves browser-discovered cookies across redirected resources without refetching the final URL",
  { timeout: 60_000 },
  async (t) => {
    let secretRequests = 0
    const pageServer = createServer((request, response) => {
      if (request.url === "/download") {
        response.writeHead(302, {
          location: "/secret.txt",
          "set-cookie": "fetch_token=allowed; Path=/; HttpOnly",
        })
        response.end()
        return
      }
      secretRequests += 1
      if (!request.headers.cookie?.includes("fetch_token=allowed")) {
        response.writeHead(401, { "content-type": "text/plain" })
        response.end("missing browser session")
        return
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      response.end("authenticated redirected resource")
    })
    await new Promise<void>((resolve, reject) => {
      pageServer.once("error", reject)
      pageServer.listen(0, "127.0.0.1", resolve)
    })
    t.after(async () => {
      await new Promise<void>((resolve) => pageServer.close(() => resolve()))
    })

    const address = pageServer.address()
    assert.ok(address && typeof address !== "string")
    const opener = new WebPageOpener()
    const result = await opener.open({
      url: `http://127.0.0.1:${address.port}/download`,
      format: "markdown",
      compact: false,
      maxOutputTokens: opener.maximumOutputTokens,
    })

    assert.equal(result.status, 200)
    assert.equal(result.url, `http://127.0.0.1:${address.port}/secret.txt`)
    assert.equal(result.content, "authenticated redirected resource")
    assert.equal(secretRequests, 1)
  }
)

liveWebTest(
  "sniffs headerless HTML, PDF, image, and text responses",
  { timeout: 60_000 },
  async (t) => {
    const pdf = createTextPdf("Headerless PDF")
    const image = await sharp({
      create: { width: 24, height: 12, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer()
    const pageServer = createServer((request, response) => {
      response.statusCode = 200
      if (request.url === "/page")
        response.end(
          "<!doctype html><html><head><title>Headerless HTML</title></head><body><h1>Rendered headerless HTML</h1></body></html>"
        )
      else if (request.url === "/doc") response.end(pdf)
      else if (request.url === "/image") response.end(image)
      else response.end("headerless plain text")
    })
    await new Promise<void>((resolve, reject) => {
      pageServer.once("error", reject)
      pageServer.listen(0, "127.0.0.1", resolve)
    })
    t.after(async () => {
      await new Promise<void>((resolve) => pageServer.close(() => resolve()))
    })

    const address = pageServer.address()
    assert.ok(address && typeof address !== "string")
    const opener = new WebPageOpener()
    const base = `http://127.0.0.1:${address.port}`

    const html = await opener.open({
      url: `${base}/page`,
      format: "markdown",
      compact: true,
      maxOutputTokens: opener.maximumOutputTokens,
    })
    assert.equal(html.title, "Headerless HTML")
    assert.match(html.content, /Rendered headerless HTML/u)

    const extractedPdf = await opener.open({
      url: `${base}/doc`,
      format: "markdown",
      compact: false,
      maxOutputTokens: opener.maximumOutputTokens,
    })
    assert.match(extractedPdf.content, /Headerless PDF/u)

    const fetchedImage = await opener.open({
      url: `${base}/image`,
      format: "markdown",
      compact: false,
      maxOutputTokens: opener.maximumOutputTokens,
    })
    assert.equal(fetchedImage.kind, "image")
    assert.equal(fetchedImage.image?.width, 24)
    assert.equal(fetchedImage.image?.height, 12)

    const text = await opener.open({
      url: `${base}/text`,
      format: "markdown",
      compact: false,
      maxOutputTokens: opener.maximumOutputTokens,
    })
    assert.equal(text.content, "headerless plain text")
  }
)

liveWebTest(
  "rejects unsupported and oversized binary resources explicitly",
  { timeout: 60_000 },
  async (t) => {
    const pageServer = createServer((request, response) => {
      if (request.url === "/chunked-large.bin") {
        response.writeHead(200, { "content-type": "application/octet-stream" })
        response.write(Buffer.alloc(40, 1))
        response.end(Buffer.alloc(40, 1))
        return
      }
      const body = request.url === "/large.bin" ? Buffer.alloc(128, 1) : Buffer.from([0, 1, 2, 3])
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": body.length,
      })
      response.end(body)
    })
    await new Promise<void>((resolve, reject) => {
      pageServer.once("error", reject)
      pageServer.listen(0, "127.0.0.1", resolve)
    })
    t.after(async () => {
      await new Promise<void>((resolve) => pageServer.close(() => resolve()))
    })

    const address = pageServer.address()
    assert.ok(address && typeof address !== "string")
    const opener = new WebPageOpener({ resourceByteLimit: 64 })

    await assert.rejects(
      opener.open({
        url: `http://127.0.0.1:${address.port}/blob.bin`,
        format: "markdown",
        compact: false,
        maxOutputTokens: opener.maximumOutputTokens,
      }),
      (error: unknown) => error instanceof WebOpenError && error.code === "unsupported_content_type"
    )
    await assert.rejects(
      opener.open({
        url: `http://127.0.0.1:${address.port}/large.bin`,
        format: "markdown",
        compact: false,
        maxOutputTokens: opener.maximumOutputTokens,
      }),
      (error: unknown) => error instanceof WebOpenError && error.code === "resource_too_large"
    )
    await assert.rejects(
      opener.open({
        url: `http://127.0.0.1:${address.port}/chunked-large.bin`,
        format: "markdown",
        compact: false,
        maxOutputTokens: opener.maximumOutputTokens,
      }),
      (error: unknown) => error instanceof WebOpenError && error.code === "resource_too_large"
    )
  }
)

function createTextPdf(text: string): Buffer {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ]
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "latin1"))
    pdf += object
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1")
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, "latin1")
}
