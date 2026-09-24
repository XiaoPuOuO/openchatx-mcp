import assert from "node:assert/strict"
import { mkdir, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import { registerSearchTools } from "../src/tools/search/search-tools.js"
import { tempDir } from "./helpers/temp.js"

async function connectedSearchServer(t: test.TestContext) {
  const server = new McpServer({ name: "search-test", version: "1.0.0" })
  const client = new Client({ name: "search-test-client", version: "1.0.0" })
  registerSearchTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([client.close(), server.close()]))
  return client
}

test("glob searches directly with ripgrep and sorts matches by modification time", async (t) => {
  const root = await tempDir(t, "openchatx-glob-")
  await mkdir(join(root, "src"))
  const older = join(root, "src", "older.ts")
  const newer = join(root, "src", "newer.ts")
  await writeFile(older, "old")
  await writeFile(newer, "new")
  await utimes(older, new Date(1_000), new Date(1_000))
  await utimes(newer, new Date(2_000), new Date(2_000))

  const client = await connectedSearchServer(t)
  const result = await client.callTool({
    name: "glob",
    arguments: { pattern: "**/*.ts", path: root },
  })
  assert.equal(result.isError, undefined)
  assert.deepEqual((result.structuredContent as { files: string[] }).files, [newer, older])
})

test("grep supports regex and include filtering", async (t) => {
  const root = await tempDir(t, "openchatx-grep-")
  await writeFile(join(root, "a.ts"), "const alpha = 1\nconst beta = 2\n")
  await writeFile(join(root, "b.js"), "const alpha = 3\n")

  const client = await connectedSearchServer(t)
  const result = await client.callTool({
    name: "grep",
    arguments: { pattern: "alpha\\s*=", path: root, include: "*.ts" },
  })
  assert.equal(result.isError, undefined)
  const matches = (result.structuredContent as { matches: Array<{ path: string; line: number }> })
    .matches
  assert.equal(matches.length, 1)
  assert.equal(matches[0]?.path, join(root, "a.ts"))
  assert.equal(matches[0]?.line, 1)
})

test("grep targeting one file does not search sibling files", async (t) => {
  const root = await tempDir(t, "openchatx-grep-file-")
  const target = join(root, "target.ts")
  await writeFile(target, "needle target\n")
  await writeFile(join(root, "sibling.ts"), "needle sibling\n")

  const client = await connectedSearchServer(t)
  const result = await client.callTool({
    name: "grep",
    arguments: { pattern: "needle", path: target },
  })
  const matches = (result.structuredContent as { matches: Array<{ path: string; text: string }> })
    .matches
  assert.equal(matches.length, 1)
  assert.equal(matches[0]?.path, target)
  assert.match(matches[0]?.text ?? "", /target/u)
})
