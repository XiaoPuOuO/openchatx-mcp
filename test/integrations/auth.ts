import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client"

import { OpenChatXAuthStore } from "../../src/auth/store.js"
import { connectClient, postWithHost, startMcpHttpServer } from "./helpers.js"

test("remote MCP binds one OpenAI subject while local MCP remains available", {
  timeout: 20_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-mcp-remote-auth-"))
  const authStore = new OpenChatXAuthStore(join(root, "auth.json"))
  await authStore.ensureState()
  const running = await startMcpHttpServer({ authStore })
  t.after(async () => {
    await running.close()
    await rm(root, { recursive: true, force: true })
  })

  assert.equal(
    await postWithHost(`${running.url}/`, `localhost:${running.port}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "remote-trailing-slash-bypass", version: "1.0.0" },
      },
    }),
    404
  )

  const local = await connectClient(running.url, "local-auth-bypass")
  t.after(() => local.client.close())
  assert.ok((await local.client.callTool({ name: "shell_list", arguments: {} })).content)

  const discovery = await connectClient(running.url, "remote-discovery", undefined, true)
  t.after(() => discovery.client.close())
  assert.ok((await discovery.client.listTools()).tools.length > 0)
  assert.equal((await authStore.readState()).subject, null)
  await assert.rejects(
    () => discovery.client.callTool({ name: "shell_list", arguments: {} }),
    /403|denied/iu
  )
  assert.equal((await authStore.readState()).subject, null)

  const owner = await connectClient(running.url, "remote-owner", "subject-a", true)
  t.after(() => owner.client.close())
  assert.ok((await owner.client.callTool({ name: "shell_list", arguments: {} })).content)
  assert.equal((await authStore.readState()).subject, "subject-a")

  const sameOwner = await connectClient(
    running.url,
    "remote-owner-new-conversation",
    "subject-a",
    true
  )
  t.after(() => sameOwner.client.close())
  assert.ok((await sameOwner.client.callTool({ name: "shell_list", arguments: {} })).content)

  const otherSubject = await connectClient(running.url, "remote-other-subject", "subject-b", true)
  t.after(() => otherSubject.client.close())
  await assert.rejects(
    () => otherSubject.client.callTool({ name: "shell_list", arguments: {} }),
    /403|denied/iu
  )
})

test("remote MCP owner survives an HTTP server restart", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-mcp-remote-restart-"))
  const filePath = join(root, "auth.json")
  const firstAuthStore = new OpenChatXAuthStore(filePath)
  await firstAuthStore.ensureState()
  let running = await startMcpHttpServer({ authStore: firstAuthStore })
  const port = running.port
  const remoteUrl = `http://${running.host}:${port}/mcp`

  const owner = await connectClient(remoteUrl, "remote-owner-before-restart", "subject-a", true)
  await owner.client.callTool({ name: "shell_list", arguments: {} })
  await owner.client.close()
  await running.close()

  const secondAuthStore = new OpenChatXAuthStore(filePath)
  assert.deepEqual(await secondAuthStore.ensureState(), { version: 1, subject: "subject-a" })
  running = await startMcpHttpServer({ port, authStore: secondAuthStore })
  t.after(async () => {
    await running.close()
    await rm(root, { recursive: true, force: true })
  })

  const afterRestart = await connectClient(
    remoteUrl,
    "remote-owner-after-restart",
    "subject-a",
    true
  )
  t.after(() => afterRestart.client.close())
  assert.ok((await afterRestart.client.callTool({ name: "shell_list", arguments: {} })).content)
})
