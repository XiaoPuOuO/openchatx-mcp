#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs"
import process from "node:process"

const args = process.argv.slice(2)
const command = args[0] ?? "unknown"
const logPath = process.env.FAKE_PEEKABOO_LOG
const delayMs = parseInteger(process.env.FAKE_PEEKABOO_DELAY_MS)

log({ event: "start", command, args, pid: process.pid })

process.on("SIGTERM", () => {
  log({ event: "signal", command, args, pid: process.pid, signal: "SIGTERM" })
  process.exit(143)
})

if (delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}

let screenshotPath
if (command === "see") {
  screenshotPath = optionValue("--path")
  if (screenshotPath) {
    writeFileSync(
      screenshotPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64"
      )
    )
  }
}

const stdoutBytes = parseInteger(process.env.FAKE_PEEKABOO_STDOUT_BYTES)
if (stdoutBytes > 0) {
  log({ event: "end", command, args, pid: process.pid })
  process.stdout.write("x".repeat(stdoutBytes))
  process.exit(0)
}

const stderrBytes = parseInteger(process.env.FAKE_PEEKABOO_STDERR_BYTES)
if (stderrBytes > 0) {
  process.stderr.write("e".repeat(stderrBytes))
}

if (process.env.FAKE_PEEKABOO_MALFORMED_JSON === "1") {
  log({ event: "end", command, args, pid: process.pid })
  process.stdout.write("not-json")
  process.exit(0)
}

const exitCode = parseInteger(process.env.FAKE_PEEKABOO_EXIT_CODE)
if (exitCode > 0) {
  log({ event: "end", command, args, pid: process.pid })
  process.stderr.write("fake process failure")
  process.exit(exitCode)
}

if (
  process.env.FAKE_PEEKABOO_FAIL_COMMAND === command &&
  (!process.env.FAKE_PEEKABOO_FAIL_SUBCOMMAND ||
    process.env.FAKE_PEEKABOO_FAIL_SUBCOMMAND === args[1])
) {
  respond({
    success: false,
    error: {
      code: "FAKE_COMMAND_FAILED",
      message: `Fake Peekaboo failure for ${command}`,
      details: "fixture requested failure",
    },
    debug_logs: ["fixture debug output"],
  })
} else if (command === "see") {
  const screenCapture = args.includes("--mode") && optionValue("--mode") === "screen"
  const treeCapture = args.includes("--tree")
  respond({
    success: true,
    data: {
      snapshot_id: screenCapture
        ? "snapshot-screen"
        : treeCapture
          ? "snapshot-inspect"
          : "snapshot-42",
      ui_elements: [
        {
          id: "B1",
          role: "AXButton",
          label: "Continue",
          bounds: screenCapture
            ? { x: 1090, y: 1620, width: 100, height: 40 }
            : { x: 60, y: 95, width: 100, height: 40 },
        },
      ],
      screenshot_raw: screenshotPath,
      screenshot_annotated: args.includes("--annotate") ? screenshotPath : undefined,
      application_name: process.env.FAKE_PEEKABOO_APP_NAME,
      observation:
        process.env.FAKE_PEEKABOO_OMIT_OBSERVATION_TARGET === "1"
          ? undefined
          : {
              target: screenCapture
                ? {
                    resolved_kind: "screen",
                  }
                : {
                    resolved_kind: "window-id",
                    window_id: 4242,
                    bounds: [
                      [50, 75],
                      [800, 600],
                    ],
                  },
            },
    },
    summary: "see:ok",
    messages: ["ready", 42],
    debug_logs: ["fixture debug output"],
  })
} else if (command === "screen" && args[1] === "list") {
  respond({
    success: true,
    data: {
      screens: [
        { index: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
        { index: 1, bounds: { x: 1080, y: 1600, width: 1440, height: 900 } },
      ],
      primaryIndex: 0,
    },
    summary: "list:ok",
    messages: ["ready", 42],
    debug_logs: ["fixture debug output"],
  })
} else {
  respond({
    success: true,
    data: { command, args },
    summary: `${command}:ok`,
    messages: ["ready", 42],
    debug_logs: ["fixture debug output"],
  })
}

function respond(value) {
  log({ event: "end", command, args, pid: process.pid })
  process.stdout.write(JSON.stringify(value))
}

function optionValue(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function parseInteger(value) {
  const parsed = Number.parseInt(value ?? "0", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function log(value) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`)
}
