import assert from "node:assert/strict"
import { chmod, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test, { type TestContext } from "node:test"

import { characterCount, formatAuditTime, McpAuditLogger } from "../src/server/audit-log.js"
import { countTokens } from "../src/tokenizer.js"
import { tempDir } from "./helpers/temp.js"

test("writes one compact YAML document for a shell command", async (t) => {
  const file = await auditFile(t)

  const timestamp = new Date(2026, 7, 7, 20, 58, 30)
  let clock = 1_000
  const logger = new McpAuditLogger(
    file,
    () => timestamp,
    () => clock
  )
  const [call] = logger.startToolCalls({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "shell_run",
      arguments: {
        shell_id: "api-audit",
        request_id: "scan-1",
        command: "rg -n foo src",
      },
    },
  })
  assert.ok(call)
  clock = 1_275
  call.finish({ httpStatus: 200, state: "finished" })
  call.finish({ httpStatus: 500, state: "closed" })

  assert.equal(formatAuditTime(timestamp), "Aug 7 8:58 PM")
  assert.equal(characterCount("🙂a"), 2)
  assert.equal(
    await readFile(file, "utf8"),
    ["--- # shell_run - 275ms - 23 in - Aug 7 8:58 PM", 'shell: "api-audit/scan-1"', "command: |-", "  rg -n foo src", "", ""].join("\n")
  )
})

test("logs shell output token count", async (t) => {
  const file = await auditFile(t)

  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 13, 19, 13, 46),
    () => 1_380
  )
  const [call] = logger.startToolCalls({
    method: "tools/call",
    params: {
      name: "shell_run",
      arguments: { shell_id: "default", request_id: "tokens", command: "printf 'hello world'" },
    },
  })
  assert.ok(call)
  const output = "hello world"
  const structuredContent = { status: "completed", exit_code: 0, cwd: "/workspace", output }
  const responseBody = JSON.stringify({
    result: {
      structuredContent,
    },
  })
  call.finish({
    httpStatus: 200,
    state: "finished",
    responseBody,
  })

  const log = await readFile(file, "utf8")
  const inputTokens = countTokens(JSON.stringify({ shell_id: "default", request_id: "tokens", command: "printf 'hello world'" }))
  const outputTokens = countTokens(JSON.stringify(structuredContent))
  assert.match(log, new RegExp(`--- # shell_run - 0ms - ${inputTokens} in / ${outputTokens} out - Aug 13 7:13 PM`))
  assert.match(log, /result: status="completed" exit_code=0 cwd="\/workspace"/)
})

test("puts audit heading before entry details with time last", async (t) => {
  const file = await auditFile(t)
  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 18, 18, 25, 0),
    () => 0
  )
  const [call] = logger.startToolCalls({ method: "tools/call", params: { name: "shell_list", arguments: {} } })
  assert.ok(call)
  call.finish({ httpStatus: 200, state: "finished" })

  assert.equal(await readFile(file, "utf8"), "--- # shell_list - 0ms - 1 in - Aug 18 6:25 PM\nargs: {}\n\n")
})

test("aliases audit sessions in first-seen order without logging raw ids", async (t) => {
  const file = await auditFile(t)
  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 18, 18, 30, 0),
    () => 0
  )
  const request = { method: "tools/call", params: { name: "shell_list", arguments: {} } }

  const [first] = logger.startToolCalls(request, { sessionId: "raw-session-a" })
  const [second] = logger.startToolCalls(request, { sessionId: "raw-session-b", parentSessionId: "raw-session-a" })
  assert.ok(first)
  assert.ok(second)

  second.finish({ httpStatus: 200, state: "finished" })
  first.finish({ httpStatus: 200, state: "finished" })

  const log = await readFile(file, "utf8")
  assert.match(log, /session: "agent-2"\nparent_session: "agent-1"/)
  assert.match(log, /session: "agent-1"/)
  assert.doesNotMatch(log, /raw-session-a|raw-session-b/)
})

test("marks explicit structured and max_output_tokens tool arguments in the heading", async (t) => {
  const file = await auditFile(t)
  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 14, 8, 11, 0),
    () => 0
  )
  const [call] = logger.startToolCalls({
    method: "tools/call",
    params: {
      name: "shell_run",
      arguments: {
        shell_id: "default",
        request_id: "markers",
        command: "pwd",
        structured: true,
        max_output_tokens: 4_096,
      },
    },
  })
  assert.ok(call)
  call.finish({ httpStatus: 200, state: "finished" })

  const log = await readFile(file, "utf8")
  assert.match(log, /^--- # shell_run - 0ms - \d+ in - structured - max_output_tokens=4096 - Aug 14 8:11 AM$/m)
})

test("matches batched tool responses by JSON-RPC id", async (t) => {
  const file = await auditFile(t)

  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 14, 0, 30, 0),
    () => 1_000
  )
  const calls = logger.startToolCalls([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "shell_list", arguments: { first: true } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "skill_load", arguments: { name: "second" } } },
  ])
  assert.equal(calls.length, 2)

  const firstOutput = "first"
  const secondOutput = "second output has several more tokens"
  const responseBody = JSON.stringify([
    { jsonrpc: "2.0", id: 2, result: { isError: true, content: [{ type: "text", text: secondOutput }] } },
    { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: firstOutput }] } },
  ])
  for (const call of calls) call.finish({ httpStatus: 200, state: "finished", responseBody })

  const log = await readFile(file, "utf8")
  assert.match(log, new RegExp(`shell_list - 0ms - ${countTokens(JSON.stringify({ first: true }))} in / ${countTokens(firstOutput)} out - Aug 14 12:30 AM`))
  assert.match(log, new RegExp(`! skill_load - 0ms - ${countTokens(JSON.stringify({ name: "second" }))} in / ${countTokens(secondOutput)} out - Aug 14 12:30 AM`))
})

test("creates and repairs audit logs with owner-only permissions", async (t) => {
  const directory = await tempDir(t, "mcp-audit-log-permissions-")
  const newFile = join(directory, "new.yaml")
  const existingFile = join(directory, "existing.yaml")

  const newLogger = new McpAuditLogger(newFile)
  const [call] = newLogger.startToolCalls({ method: "tools/call", params: { name: "shell_list", arguments: {} } })
  assert.ok(call)
  call.finish({ httpStatus: 200, state: "finished" })
  assert.equal((await stat(newFile)).mode & 0o777, 0o600)

  await writeFile(existingFile, "existing\n")
  await chmod(existingFile, 0o644)
  new McpAuditLogger(existingFile)
  assert.equal((await stat(existingFile)).mode & 0o777, 0o600)
  assert.equal(await readFile(existingFile, "utf8"), "existing\n")
})

test("logs apply_patch bodies only when the tool fails", async (t) => {
  const file = await auditFile(t)

  const timestamp = new Date(2026, 7, 7, 21, 12, 3)
  let clock = 2_000
  const logger = new McpAuditLogger(
    file,
    () => timestamp,
    () => clock
  )
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch"
  const [call] = logger.startToolCalls({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "apply_patch", arguments: { patch, cwd: "/workspace/project" } },
  })
  assert.ok(call)
  clock = 2_051
  call.finish({ httpStatus: 200, state: "finished", responseBody: '{"result":{"isError":false}}' })

  let log = await readFile(file, "utf8")
  assert.equal(log, `--- # apply_patch - 51ms - 33 in - Aug 7 9:12 PM\ncwd: "/workspace/project"\npatch_chars: ${characterCount(patch)}\n\n`)
  assert.doesNotMatch(log, /Begin Patch|Update File|old|new/)

  const [failedCall] = logger.startToolCalls({
    method: "tools/call",
    params: { name: "apply_patch", arguments: { patch, cwd: "/workspace/project" } },
  })
  assert.ok(failedCall)
  clock = 2_100
  failedCall.finish({
    httpStatus: 200,
    state: "finished",
    responseBody: `event: message\ndata: ${JSON.stringify({
      result: {
        isError: true,
        structuredContent: { status: "failed", exit_code: 1, output: "Invalid patch hunk on line 4\nUnexpected @@" },
      },
    })}\n\n`,
  })

  log = await readFile(file, "utf8")
  assert.match(log, /--- # ! apply_patch - 49ms - \d+ in \/ \d+ out - Aug 7 9:12 PM/)
  assert.match(log, /message: "Invalid patch hunk on line 4\\nUnexpected @@"/)
  assert.match(log, /patch: \|-\n {2}\*\*\* Begin Patch/)
  assert.match(log, / {2}\+new/)

  const [thrownFailure] = logger.startToolCalls({
    method: "tools/call",
    params: { name: "apply_patch", arguments: { patch, cwd: "/workspace/project" } },
  })
  assert.ok(thrownFailure)
  thrownFailure.finish({
    httpStatus: 200,
    state: "finished",
    responseBody: JSON.stringify({
      result: {
        isError: true,
        content: [{ type: "text", text: "apply_patch_failed: apply_patch request was aborted." }],
      },
    }),
  })

  log = await readFile(file, "utf8")
  assert.match(log, /message: "apply_patch_failed: apply_patch request was aborted\."/)
})

test("logs shell tool errors with their MCP failure reason", async (t) => {
  const file = await auditFile(t)

  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 11, 22, 50, 0),
    () => 100
  )
  const [run] = logger.startToolCalls({
    method: "tools/call",
    params: {
      name: "shell_run",
      arguments: { shell_id: "parallel", request_id: "bad-batch", command: "*** Run\npwd" },
    },
  })
  assert.ok(run)
  run.finish({
    httpStatus: 200,
    state: "finished",
    responseBody: `event: message\ndata: ${JSON.stringify({
      result: {
        isError: true,
        content: [{ type: "text", text: "invalid_command: Expected '*** Run:' or '*** Run: <directory>' on line 1." }],
      },
    })}\n\n`,
  })

  const [poll] = logger.startToolCalls({
    method: "tools/call",
    params: { name: "shell_poll", arguments: { shell_id: "parallel", request_id: "missing", cursor: 0 } },
  })
  assert.ok(poll)
  poll.finish({
    httpStatus: 200,
    state: "finished",
    responseBody: `event: message\ndata: ${JSON.stringify({
      result: {
        isError: true,
        content: [{ type: "text", text: "unknown_request: No retained command for request_id missing." }],
      },
    })}\n\n`,
  })

  const log = await readFile(file, "utf8")
  assert.match(log, /--- # ! shell_run - .* - Aug 11 10:50 PM/)
  assert.match(log, /message: "invalid_command: Expected '\*\*\* Run:' or '\*\*\* Run: <directory>' on line 1\."/)
  assert.match(log, /--- # ! shell_poll - .* - Aug 11 10:50 PM/)
  assert.match(log, /shell: "parallel\/missing"\ncursor: 0\nmessage: "unknown_request: No retained command for request_id missing\."/)

  const [childNonzero] = logger.startToolCalls({
    method: "tools/call",
    params: {
      name: "shell_run",
      arguments: { shell_id: "parallel", request_id: "child-nonzero", command: "*** Run: .\nfalse" },
    },
  })
  assert.ok(childNonzero)
  childNonzero.finish({
    httpStatus: 200,
    state: "finished",
    responseBytes: 9_000,
    responseBodyTruncated: true,
    responseBody: '{"result":{"isError":false,"structuredContent":{"status":"completed","exit_code":1,"cwd":"/workspace","output":"' + "x".repeat(2_000),
  })

  const finalLog = await readFile(file, "utf8")
  assert.match(finalLog, /--- # ! shell_run - 0ms - \d+ in - response_bytes=9000 - audit_capture_truncated - Aug 11 10:50 PM\nshell: "parallel\/child-nonzero"\ncommand: \|-\n {2}\*\*\* Run: \.\n {2}false\nresult: status="completed" exit_code=1 cwd="\/workspace"/)
})

test("caps large ordinary tool arguments", async (t) => {
  const file = await auditFile(t)

  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 7, 22, 0, 0),
    () => 0
  )
  const [call] = logger.startToolCalls({
    method: "tools/call",
    params: { name: "skill_load", arguments: { name: "x".repeat(2_000) } },
  })
  assert.ok(call)
  call.finish({ httpStatus: 200, state: "finished" })

  const log = await readFile(file, "utf8")
  assert.match(log, /^--- # skill_load - 0ms - \d+ in - Aug 7 10:00 PM\nargs: "/)
  assert.match(log, /chars omitted/)
  assert.ok(log.length < 800)
})

test("uses Better Comments tags for slow and failed calls", async (t) => {
  const file = await auditFile(t)

  let clock = 0
  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 7, 22, 30, 0),
    () => clock
  )
  const request = { method: "tools/call", params: { name: "shell_list", arguments: {} } }

  const [normal] = logger.startToolCalls(request)
  assert.ok(normal)
  clock = 100
  normal.finish({ httpStatus: 200, state: "finished" })

  const [slow] = logger.startToolCalls(request)
  assert.ok(slow)
  clock = 5_200
  slow.finish({ httpStatus: 200, state: "finished" })

  const [failed] = logger.startToolCalls(request)
  assert.ok(failed)
  clock = 5_250
  failed.finish({ httpStatus: 500, state: "closed" })

  const log = await readFile(file, "utf8")
  assert.match(log, /--- # shell_list - 100ms - 1 in - Aug 7 10:30 PM/)
  assert.match(log, /--- # ~ shell_list - 5100ms - 1 in - Aug 7 10:30 PM/)
  assert.match(log, /--- # ! shell_list - 50ms - 1 in - HTTP 500 closed - Aug 7 10:30 PM/)
  assert.doesNotMatch(log, /--- # \?/)
})

test("logs tools/list as one timestamped line and ignores other non-tool MCP requests", async (t) => {
  const file = await auditFile(t)

  const timestamp = new Date(2026, 7, 7, 22, 30, 0)
  const logger = new McpAuditLogger(file, () => timestamp)
  assert.deepEqual(logger.startToolCalls({ jsonrpc: "2.0", id: 1, method: "tools/list" }), [])
  assert.deepEqual(logger.startToolCalls({ jsonrpc: "2.0", id: 2, method: "initialize" }), [])
  assert.equal(await readFile(file, "utf8"), "--- # tools/list - Aug 7 10:30 PM\n")
})

test("logs compact computer metadata without retaining screenshot or inspection contents", async (t) => {
  const file = await auditFile(t)
  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 26, 23, 0, 0),
    () => 0
  )
  const [call] = logger.startToolCalls({
    method: "tools/call",
    params: { name: "computer_observe", arguments: { window_id: 42, annotate: false } },
  })
  assert.ok(call)
  call.finish({
    httpStatus: 200,
    state: "finished",
    responseBytes: 1_250_000,
    responseBody: JSON.stringify({
      result: {
        content: [{ type: "text", text: "Observed Finder — Downloads." }],
        structuredContent: {
          snapshot_id: "snapshot-42",
          application_name: "Finder",
          window_title: "Downloads",
          capture_mode: "window",
          element_count: 18,
          interactable_count: 7,
        },
      },
    }),
  })

  const log = await readFile(file, "utf8")
  assert.match(log, /computer_observe .* \d+ out .*Aug 26 11:00 PM/)
  assert.match(log, /result: snapshot_id="snapshot-42" app="Finder" window="Downloads" capture_mode="window" elements=18 interactable=7/)
  assert.doesNotMatch(log, /Observed Finder/)
})

test("records response size when the bounded audit capture overflows", async (t) => {
  const file = await auditFile(t)
  const logger = new McpAuditLogger(file, () => new Date(2026, 7, 26, 23, 5, 0), () => 0)
  const [call] = logger.startToolCalls({ method: "tools/call", params: { name: "computer_observe", arguments: {} } })
  assert.ok(call)
  const responsePrefix =
    '{"result":{"structuredContent":{"snapshot_id":"snapshot-large","application_name":"Finder","window_title":"Downloads","capture_mode":"window","element_count":21,"interactable_count":8},"content":[{"type":"image","data":"' +
    "x".repeat(2_000)
  call.finish({ httpStatus: 200, state: "finished", responseBytes: 900_000, responseBodyTruncated: true, responseBody: responsePrefix })

  const log = await readFile(file, "utf8")
  assert.match(log, /response_bytes=900000 - audit_capture_truncated - Aug 26 11:05 PM/)
  assert.match(log, /result: snapshot_id="snapshot-large" app="Finder" window="Downloads" capture_mode="window" elements=21 interactable=8/)
})

async function auditFile(t: TestContext): Promise<string> {
  return join(await tempDir(t, "mcp-audit-log-"), "agent-commands.yaml")
}
