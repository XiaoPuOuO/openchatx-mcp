import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { GithubCommunityStore } from "../src/store/github-community-store.js"
import { CapabilityStoreService } from "../src/store/store-service.js"

const encoder = new TextEncoder()

test("GitHub community Store discovers, reviews, and installs an exact revision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-community-store-"))
  t.after(() => rm(root, { recursive: true, force: true }))

  const catalog = join(root, "catalog.json")
  const bundles = join(root, "bundles")
  const toolboxRoot = join(root, "toolboxes")
  await mkdir(bundles, { recursive: true })
  await writeFile(catalog, '{"entries":[]}\n')

  const manifest = JSON.stringify({
    schema_version: 1,
    name: "Demo Capability",
    description: "Demo community capability",
    tags: ["demo"],
    toolbox_path: "cap",
    permissions: {
      shell: false,
      network: false,
      filesystem: false,
      secrets: false,
    },
  })
  const toolbox = JSON.stringify({
    name: "Demo Capability",
    description: "Demo",
    enabled: true,
    tools: {},
    skills: {},
  })
  const toolSource = [
    'import { exec } from "node:child_process"',
    "const token = process.env.DEMO_TOKEN",
    'export const value = () => exec("echo hi")',
  ].join("\n")

  const requested: string[] = []
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url
    )
    requested.push(`${url.pathname}${url.search}`)

    if (url.pathname === "/search/repositories") {
      return jsonResponse({
        items: [
          {
            full_name: "demo/openchatx-capability-demo",
            name: "openchatx-capability-demo",
            description: "Demo community capability",
            html_url: "https://github.com/demo/openchatx-capability-demo",
            default_branch: "main",
            stargazers_count: 7,
            updated_at: "2026-09-25T00:00:00Z",
            owner: { login: "demo" },
          },
        ],
      })
    }
    if (url.pathname === "/repos/demo/openchatx-capability-demo") {
      return jsonResponse({
        full_name: "demo/openchatx-capability-demo",
        name: "openchatx-capability-demo",
        description: "Demo community capability",
        html_url: "https://github.com/demo/openchatx-capability-demo",
        default_branch: "main",
        stargazers_count: 7,
        updated_at: "2026-09-25T00:00:00Z",
        owner: { login: "demo" },
      })
    }
    if (
      url.pathname === "/repos/demo/openchatx-capability-demo/commits/main" ||
      url.pathname === "/repos/demo/openchatx-capability-demo/commits/abc123"
    ) {
      return jsonResponse({ sha: "abc123", commit: { tree: { sha: "tree123" } } })
    }
    if (url.pathname === "/repos/demo/openchatx-capability-demo/contents/capability.json") {
      return encodedResponse(manifest)
    }
    if (url.pathname === "/repos/demo/openchatx-capability-demo/git/trees/tree123") {
      return jsonResponse({
        truncated: false,
        tree: [
          {
            path: "capability.json",
            mode: "100644",
            type: "blob",
            sha: "manifest",
            size: encoder.encode(manifest).length,
          },
          {
            path: "cap/toolbox.json",
            mode: "100644",
            type: "blob",
            sha: "toolbox",
            size: encoder.encode(toolbox).length,
          },
          {
            path: "cap/tools/run.ts",
            mode: "100644",
            type: "blob",
            sha: "run",
            size: encoder.encode(toolSource).length,
          },
        ],
      })
    }
    if (url.pathname === "/repos/demo/openchatx-capability-demo/git/blobs/toolbox") {
      return encodedResponse(toolbox)
    }
    if (url.pathname === "/repos/demo/openchatx-capability-demo/git/blobs/run") {
      return encodedResponse(toolSource)
    }
    if (url.pathname === "/repos/demo/openchatx-capability-demo/git/blobs/manifest") {
      return encodedResponse(manifest)
    }
    return new Response("not found", { status: 404 })
  }

  const community = new GithubCommunityStore({
    apiBase: "https://api.test",
    token: "test-token",
    fetchImpl: fetchImpl as typeof fetch,
  })
  const store = new CapabilityStoreService(
    catalog,
    bundles,
    toolboxRoot,
    undefined,
    root,
    community
  )

  const browse = await store.browse("demo", "community")
  assert.equal(browse.entries[0]?.id, "github:demo/openchatx-capability-demo")
  assert.equal(browse.entries[0]?.source, "github")

  const tree = await store.sourceTree("github:demo/openchatx-capability-demo")
  assert.equal(tree.revision, "abc123")
  assert.ok(tree.files.some((file) => file.path === "cap/tools/run.ts"))

  const review = await store.review("github:demo/openchatx-capability-demo", tree.revision)
  assert.equal(review.revision, "abc123")
  assert.equal(review.observedPermissions.shell, true)
  assert.equal(review.observedPermissions.secrets, true)
  assert.ok(
    review.findings.some(
      (finding) => finding.category === "manifest" && finding.detail.includes("shell")
    )
  )

  const source = await store.sourceRead(
    "github:demo/openchatx-capability-demo",
    "cap/tools/run.ts",
    tree.revision
  )
  assert.match(source.content, /child_process/u)

  const installed = await store.install("github:demo/openchatx-capability-demo", tree.revision)
  assert.equal(installed.source, "github")
  if (installed.source !== "github") throw new Error("Expected GitHub Store entry.")
  assert.equal(installed.revision, "abc123")
  assert.match(
    await readFile(join(toolboxRoot, "gh-demo-openchatx-capability-demo", "toolbox.json"), "utf8"),
    /Demo Capability/u
  )
  assert.ok(
    requested.some((path) => path.includes("/repos/demo/openchatx-capability-demo/commits/abc123"))
  )

  await store.uninstall("github:demo/openchatx-capability-demo")
  await assert.rejects(
    () => readFile(join(toolboxRoot, "gh-demo-openchatx-capability-demo", "toolbox.json"), "utf8"),
    /ENOENT/u
  )
})

test("publish check validates a local capability for GitHub topic discovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-publish-check-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const capabilityRoot = join(root, "capability")
  await mkdir(capabilityRoot, { recursive: true })
  await writeFile(
    join(capabilityRoot, "capability.json"),
    JSON.stringify({
      schema_version: 1,
      name: "Publish Me",
      description: "Example",
      toolbox_path: ".",
      permissions: {},
    })
  )
  await writeFile(join(capabilityRoot, "toolbox.json"), '{"name":"Publish Me"}\n')

  const catalog = join(root, "catalog.json")
  const bundles = join(root, "bundles")
  await mkdir(bundles)
  await writeFile(catalog, '{"entries":[]}\n')
  const store = new CapabilityStoreService(
    catalog,
    bundles,
    join(root, "toolboxes"),
    undefined,
    root
  )
  const check = await store.preparePublish(capabilityRoot)

  assert.equal(check.topic, "openchatx-capability")
  assert.equal(check.manifest.name, "Publish Me")
  assert.ok(check.instructions.some((line) => line.includes("public GitHub repository")))
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function encodedResponse(value: string): Response {
  return jsonResponse({
    content: Buffer.from(value, "utf8").toString("base64"),
    encoding: "base64",
    size: encoder.encode(value).length,
  })
}
