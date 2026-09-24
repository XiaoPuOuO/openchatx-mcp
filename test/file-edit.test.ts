import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import { registerFileEditTool } from "../src/tools/file/file-tools.js"
import { tempDir } from "./helpers/temp.js"

async function connectedFileEdit(t: test.TestContext) {
  const server = new McpServer({ name: "file-edit-test", version: "1.0.0" })
  const client = new Client({ name: "file-edit-client", version: "1.0.0" })
  registerFileEditTool(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([client.close(), server.close()]))
  return client
}

test("file_edit replaces one unique exact string", async (t) => {
  const root = await tempDir(t, "openchatx-file-edit-")
  const path = join(root, "example.ts")
  await writeFile(path, "const value = 1\nconst other = 2\n")
  const client = await connectedFileEdit(t)

  const result = await client.callTool({
    name: "file_edit",
    arguments: {
      filePath: path,
      oldString: "const value = 1",
      newString: "const value = 42",
    },
  })
  assert.equal(result.isError, undefined)
  assert.equal(await readFile(path, "utf8"), "const value = 42\nconst other = 2\n")
  assert.equal((result.structuredContent as { replacements: number }).replacements, 1)
})

test("file_edit refuses ambiguous matches unless replaceAll is true", async (t) => {
  const root = await tempDir(t, "openchatx-file-edit-many-")
  const path = join(root, "example.txt")
  await writeFile(path, "same\nsame\n")
  const client = await connectedFileEdit(t)

  const ambiguous = await client.callTool({
    name: "file_edit",
    arguments: { filePath: path, oldString: "same", newString: "changed" },
  })
  assert.equal(ambiguous.isError, true)
  assert.match(
    ambiguous.content.find((item) => item.type === "text")?.text ?? "",
    /multiple matches/u
  )
  assert.equal(await readFile(path, "utf8"), "same\nsame\n")

  const replaced = await client.callTool({
    name: "file_edit",
    arguments: { filePath: path, oldString: "same", newString: "changed", replaceAll: true },
  })
  assert.equal(replaced.isError, undefined)
  assert.equal(await readFile(path, "utf8"), "changed\nchanged\n")
})

test("file_edit preserves CRLF when model input uses LF", async (t) => {
  const root = await tempDir(t, "openchatx-file-edit-crlf-")
  const path = join(root, "example.txt")
  await writeFile(path, "first\r\nsecond\r\n")
  const client = await connectedFileEdit(t)

  const result = await client.callTool({
    name: "file_edit",
    arguments: {
      filePath: path,
      oldString: "first\nsecond",
      newString: "one\ntwo",
    },
  })
  assert.equal(result.isError, undefined)
  assert.equal(await readFile(path, "utf8"), "one\r\ntwo\r\n")
})

test("file_edit can create a new file when oldString is empty", async (t) => {
  const root = await tempDir(t, "openchatx-file-edit-create-")
  const path = join(root, "nested", "created.txt")
  const client = await connectedFileEdit(t)

  const result = await client.callTool({
    name: "file_edit",
    arguments: {
      filePath: path,
      oldString: "",
      newString: "created\n",
    },
  })
  assert.equal(result.isError, undefined)
  assert.equal(await readFile(path, "utf8"), "created\n")
  const output = result.structuredContent as { created?: boolean; diff: string }
  assert.equal(output.created, true)
  assert.match(output.diff, /\+created/u)
})

test("file_edit uses conservative line-trimmed matching when exact whitespace differs", async (t) => {
  const root = await tempDir(t, "openchatx-file-edit-trimmed-")
  const path = join(root, "example.ts")
  await writeFile(path, "function demo() {\n  const value = 1\n  return value\n}\n")
  const client = await connectedFileEdit(t)

  const result = await client.callTool({
    name: "file_edit",
    arguments: {
      filePath: path,
      oldString: "const value = 1\nreturn value",
      newString: "  const value = 2\n  return value",
    },
  })
  assert.equal(result.isError, undefined)
  assert.equal(
    await readFile(path, "utf8"),
    "function demo() {\n  const value = 2\n  return value\n}\n"
  )
})
