import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { PeekabooClient } from "../../src/tools/computer/peekaboo.js"
import { connectClient, startMcpHttpServer } from "./helpers.js"

test("routes Computer Use through Peekaboo and preserves semantic errors", {
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekaboo-mcp-integration-"))
  const logPath = join(root, "peekaboo.jsonl")
  const fixture = fileURLToPath(new URL("../fixtures/fake-peekaboo.mjs", import.meta.url))
  const peekaboo = new PeekabooClient({
    executable: process.execPath,
    baseArgs: [fixture],
    env: {
      ...process.env,
      FAKE_PEEKABOO_FAIL_COMMAND: "app",
      FAKE_PEEKABOO_FAIL_SUBCOMMAND: "switch",
      FAKE_PEEKABOO_LOG: logPath,
    },
    timeoutMs: 2_000,
    localOnly: true,
  })
  const running = await startMcpHttpServer({ peekaboo })
  t.after(async () => {
    await running.close()
    await rm(root, { recursive: true, force: true })
  })
  const connected = await connectClient(running.url, "computer-use-integration-client")
  t.after(() => connected.client.close())

  const windows = await connected.client.callTool({
    name: "computer_list",
    arguments: { kind: "windows", app: "Finder", include_hidden: true, include_background: true },
  })
  assert.deepEqual(windows.structuredContent, {
    command: "window",
    args: ["window", "list", "--app", "Finder", "--no-remote", "--json"],
  })

  const missingWindowApp = await connected.client.callTool({
    name: "computer_list",
    arguments: { kind: "windows" },
  })
  assert.equal(missingWindowApp.isError, true)
  assert.match(
    missingWindowApp.content[0]?.type === "text" ? missingWindowApp.content[0].text : "",
    /app is required/u
  )

  const observed = await connected.client.callTool({
    name: "computer_observe",
    arguments: { app: "Finder" },
  })
  assert.equal(observed.isError, undefined)
  assert.deepEqual(
    observed.content.map((block) => block.type),
    ["text", "image"]
  )
  assert.deepEqual(observed.structuredContent, { snapshot_id: "snapshot-42" })

  const inspected = await connected.client.callTool({
    name: "computer_inspect",
    arguments: { snapshot_id: "snapshot-42", max_depth: 4, max_elements: 20, max_children: 10 },
  })
  assert.deepEqual(inspected.content, [
    { type: "text", text: 'snapshot_id=snapshot-inspect\n[B1] AXButton "Continue"' },
  ])
  assert.deepEqual(inspected.structuredContent, {
    snapshot_id: "snapshot-inspect",
    text: '[B1] AXButton "Continue"',
  })

  const clicked = await connected.client.callTool({
    name: "computer_click",
    arguments: { snapshot_id: "snapshot-inspect", element_id: "B1" },
  })
  assert.equal(clicked.isError, undefined)
  assert.deepEqual(clicked.structuredContent, {
    command: "click",
    args: ["click", "--on", "B1", "--snapshot", "snapshot-inspect", "--no-remote", "--json"],
  })

  const coordinateClick = await connected.client.callTool({
    name: "computer_click",
    arguments: { snapshot_id: "snapshot-inspect", x: 10, y: 20 },
  })
  assert.deepEqual(coordinateClick.structuredContent, {
    command: "click",
    args: [
      "click",
      "--at",
      "10,20",
      "--window-id",
      "4242",
      "--snapshot",
      "snapshot-42",
      "--no-remote",
      "--json",
    ],
  })

  const backgroundLongPress = await connected.client.callTool({
    name: "computer_click",
    arguments: { snapshot_id: "snapshot-inspect", x: 10, y: 20, long_press: true },
  })
  assert.deepEqual(backgroundLongPress.structuredContent, {
    command: "click",
    args: [
      "click",
      "--at",
      "10,20",
      "--window-id",
      "4242",
      "--long-press",
      "--snapshot",
      "snapshot-42",
      "--no-remote",
      "--json",
    ],
  })

  const middleClick = await connected.client.callTool({
    name: "computer_click",
    arguments: { snapshot_id: "snapshot-inspect", element_id: "B1", button: "middle" },
  })
  assert.deepEqual(middleClick.structuredContent, {
    command: "click",
    args: [
      "click",
      "--on",
      "B1",
      "--snapshot",
      "snapshot-inspect",
      "--middle",
      "--no-remote",
      "--json",
    ],
  })

  const tripleClick = await connected.client.callTool({
    name: "computer_click",
    arguments: { snapshot_id: "snapshot-inspect", element_id: "B1", click_count: 3 },
  })
  assert.deepEqual(tripleClick.structuredContent, {
    command: "click",
    args: [
      "click",
      "--on",
      "B1",
      "--snapshot",
      "snapshot-inspect",
      "--triple",
      "--no-remote",
      "--json",
    ],
  })

  const targetedScroll = await connected.client.callTool({
    name: "computer_scroll",
    arguments: { snapshot_id: "snapshot-inspect", element_id: "B1", direction: "down", amount: 4 },
  })
  assert.deepEqual(targetedScroll.structuredContent, {
    command: "scroll",
    args: [
      "scroll",
      "--direction",
      "down",
      "--amount",
      "4",
      "--on",
      "B1",
      "--snapshot",
      "snapshot-inspect",
      "--no-remote",
      "--json",
    ],
  })

  const coordinateScroll = await connected.client.callTool({
    name: "computer_scroll",
    arguments: { snapshot_id: "snapshot-inspect", x: 10, y: 20, direction: "down", amount: 4 },
  })
  assert.deepEqual(coordinateScroll.structuredContent, {
    command: "scroll",
    args: [
      "scroll",
      "--direction",
      "down",
      "--amount",
      "4",
      "--at",
      "10,20",
      "--window-id",
      "4242",
      "--snapshot",
      "snapshot-42",
      "--no-remote",
      "--json",
    ],
  })

  const pointerScroll = await connected.client.callTool({
    name: "computer_scroll",
    arguments: { direction: "down", foreground: true },
  })
  assert.deepEqual(pointerScroll.structuredContent, {
    command: "scroll",
    args: ["scroll", "--direction", "down", "--foreground", "--no-remote", "--json"],
  })

  const dragged = await connected.client.callTool({
    name: "computer_drag",
    arguments: {
      snapshot_id: "snapshot-inspect",
      from: { x: 10, y: 20 },
      to: { x: 30, y: 40 },
      duration_ms: 500,
      steps: 12,
    },
  })
  assert.deepEqual(dragged.structuredContent, {
    command: "drag",
    args: [
      "drag",
      "--from",
      "10,20",
      "--to",
      "30,40",
      "--window-id",
      "4242",
      "--duration",
      "500",
      "--steps",
      "12",
      "--snapshot",
      "snapshot-42",
      "--no-remote",
      "--json",
    ],
  })

  const unsupportedDrag = await connected.client.callTool({
    name: "computer_drag",
    arguments: {
      snapshot_id: "snapshot-inspect",
      from: { x: 10, y: 20 },
      to: { x: 30, y: 40 },
      modifiers: ["shift"],
    },
  })
  assert.equal(unsupportedDrag.isError, true)
  assert.match(
    unsupportedDrag.content[0]?.type === "text" ? unsupportedDrag.content[0].text : "",
    /modifiers|unrecognized|invalid/iu
  )

  const typed = await connected.client.callTool({
    name: "computer_type",
    arguments: { app: "Finder", text: "hello", press_return: true },
  })
  assert.deepEqual(typed.structuredContent, {
    command: "type",
    args: ["type", "--text", "hello\n", "--app", "Finder", "--no-remote", "--json"],
  })

  const restored = await connected.client.callTool({
    name: "computer_window",
    arguments: { action: "restore", app: "Finder", window_id: 4242 },
  })
  assert.deepEqual(restored.structuredContent, {
    command: "window",
    args: ["window", "restore", "--app", "Finder", "--window-id", "4242", "--no-remote", "--json"],
  })

  const closed = await connected.client.callTool({
    name: "computer_window",
    arguments: { action: "close", window_id: 4242, foreground: true },
  })
  assert.deepEqual(closed.structuredContent, {
    command: "window",
    args: ["window", "close", "--window-id", "4242", "--foreground", "--no-remote", "--json"],
  })

  const exactObserved = await connected.client.callTool({
    name: "computer_observe",
    arguments: { app: "Finder", window_id: 4242 },
  })
  assert.equal(exactObserved.isError, undefined)
  const events = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string; command: string; args: string[] })
  const exactObserve = [...events]
    .reverse()
    .find(
      (event) =>
        event.event === "start" &&
        event.command === "see" &&
        event.args.includes("--app") &&
        event.args.includes("--window-id")
    )
  assert.ok(exactObserve)
  assert.deepEqual(exactObserve.args.slice(0, 5), ["see", "--app", "Finder", "--window-id", "4242"])
  assert.equal(exactObserve.args.includes("--no-remote"), true)

  const screenObserved = await connected.client.callTool({
    name: "computer_observe",
    arguments: { screen_index: 1 },
  })
  assert.equal(screenObserved.isError, undefined)
  assert.deepEqual(screenObserved.structuredContent, { snapshot_id: "snapshot-screen" })

  const screenClick = await connected.client.callTool({
    name: "computer_click",
    arguments: { snapshot_id: "snapshot-screen", x: 10, y: 20 },
  })
  assert.deepEqual(screenClick.structuredContent, {
    command: "click",
    args: ["click", "--at", "1090,1620", "--global", "--foreground", "--no-remote", "--json"],
  })

  const launched = await connected.client.callTool({
    name: "computer_app",
    arguments: { action: "launch", app: "TextEdit", open: ["/tmp/example.txt"] },
  })
  assert.deepEqual(launched.structuredContent, {
    command: "app",
    args: [
      "app",
      "launch",
      "TextEdit",
      "--wait-ready",
      "--foreground",
      "--open",
      "/tmp/example.txt",
      "--no-remote",
      "--json",
    ],
  })

  const relaunched = await connected.client.callTool({
    name: "computer_app",
    arguments: { action: "relaunch", app: "TextEdit", force: true },
  })
  assert.deepEqual(relaunched.structuredContent, {
    command: "app",
    args: [
      "app",
      "relaunch",
      "TextEdit",
      "--wait-until-ready",
      "--foreground",
      "--force",
      "--no-remote",
      "--json",
    ],
  })

  const unhidden = await connected.client.callTool({
    name: "computer_app",
    arguments: { action: "unhide", app: "TextEdit" },
  })
  assert.deepEqual(unhidden.structuredContent, {
    command: "app",
    args: ["app", "unhide", "--app", "TextEdit", "--activate", "--no-remote", "--json"],
  })

  const failed = await connected.client.callTool({
    name: "computer_app",
    arguments: { action: "switch", app: "Finder" },
  })
  assert.equal(failed.isError, true)
  assert.deepEqual(failed.content, [
    {
      type: "text",
      text: "FAKE_COMMAND_FAILED: Fake Peekaboo failure for app (fixture requested failure)",
    },
  ])
})
