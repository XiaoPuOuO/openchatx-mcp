import assert from "node:assert/strict"
import test from "node:test"

import type { JobManager } from "../src/jobs/job-manager.js"
import { RuntimeProcessService } from "../src/runtime/process-service.js"
import type { BashProcessManager } from "../src/tools/shell/bash-process-manager.js"
import type { InteractiveShellManager } from "../src/tools/shell/interactive-shell.js"

test("process manager only exposes active durable jobs, kept bash processes, and terminals", async () => {
  const jobs = {
    list: async () => [
      {
        id: "running-job",
        label: "running",
        command: "sleep 60",
        cwd: "/tmp",
        pid: 101,
        status: "running",
        createdAt: "2026-10-03T00:00:00.000Z",
        updatedAt: "2026-10-03T00:00:00.000Z",
        logPath: "/tmp/running.log",
      },
      {
        id: "completed-job",
        label: "completed",
        command: "true",
        cwd: "/tmp",
        pid: 102,
        status: "completed",
        createdAt: "2026-10-03T00:00:01.000Z",
        updatedAt: "2026-10-03T00:00:01.000Z",
        exitCode: 0,
        logPath: "/tmp/completed.log",
      },
      {
        id: "failed-job",
        label: "failed",
        command: "false",
        cwd: "/tmp",
        pid: 103,
        status: "failed",
        createdAt: "2026-10-03T00:00:02.000Z",
        updatedAt: "2026-10-03T00:00:02.000Z",
        exitCode: 1,
        logPath: "/tmp/failed.log",
      },
      {
        id: "cancelled-job",
        label: "cancelled",
        command: "sleep 60",
        cwd: "/tmp",
        pid: 104,
        status: "cancelled",
        createdAt: "2026-10-03T00:00:03.000Z",
        updatedAt: "2026-10-03T00:00:03.000Z",
        logPath: "/tmp/cancelled.log",
      },
    ],
  } as unknown as JobManager

  const bash = {
    list: async () => [
      {
        id: "bash-running",
        pid: 201,
        command: "sleep 60",
        cwd: "/tmp",
        logPath: "/tmp/bash-running.log",
        startedAt: "2026-10-03T00:00:04.000Z",
        running: true,
      },
      {
        id: "bash-finished",
        pid: 202,
        command: "true",
        cwd: "/tmp",
        logPath: "/tmp/bash-finished.log",
        startedAt: "2026-10-03T00:00:05.000Z",
        running: false,
      },
    ],
  } as unknown as BashProcessManager

  const terminals = {
    list: () => [
      {
        session_id: "terminal-running",
        status: "running",
        cwd: "/tmp",
        exit_code: null,
      },
      {
        session_id: "terminal-exited",
        status: "exited",
        cwd: "/tmp",
        exit_code: 0,
      },
    ],
  } as unknown as InteractiveShellManager

  const service = new RuntimeProcessService(jobs, bash, terminals)
  const processes = await service.list()

  assert.equal(
    processes.some((process) => process.id === "job:running-job"),
    true
  )
  assert.equal(
    processes.some((process) => process.id === "bash:bash-running"),
    true
  )
  assert.equal(
    processes.some((process) => process.id === "terminal:terminal-running"),
    true
  )

  assert.equal(
    processes.some((process) => process.id === "job:completed-job"),
    false
  )
  assert.equal(
    processes.some((process) => process.id === "job:failed-job"),
    false
  )
  assert.equal(
    processes.some((process) => process.id === "job:cancelled-job"),
    false
  )
  assert.equal(
    processes.some((process) => process.id === "bash:bash-finished"),
    false
  )
  assert.equal(
    processes.some((process) => process.id === "terminal:terminal-exited"),
    false
  )
})
