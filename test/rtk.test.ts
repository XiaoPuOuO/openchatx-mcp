import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import test, { type TestContext } from "node:test"
import { MCP_CONFIG } from "../src/config.js"
import { prepareShellCommand } from "../src/tools/shell/rtk.js"
import { createShellSession } from "../src/tools/shell/session.js"
import { runToCompletion } from "./helpers/shell.js"

test("installed RTK default reads preserve source bytes exactly", {
  skip: !MCP_CONFIG.shell.rtkExecutable,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-rtk-read-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "fixture.ts")
  const source = [
    "// leading comment",
    "export function example(a: number, b: number) {",
    "  // keep this comment",
    "  const sum = a + b",
    "",
    "  return sum",
    "}",
    "",
  ].join("\n")
  await writeFile(path, source)

  const read = spawnSync(MCP_CONFIG.shell.rtkExecutable!, ["read", path], { encoding: "utf8" })
  assert.equal(read.status, 0)
  assert.equal(read.stdout, source)
})

test("prepares supported commands through RTK without changing the caller command", async (t) => {
  const root = await fakeRtkRoot(t)
  const path = join(root, "fixture.txt")
  const source = "alpha\n  beta\n"
  await writeFile(path, source)
  const env = { ...process.env, HOME: root, PATH: "/usr/bin:/bin" }
  const command = "cat fixture.txt"
  useRtk(t, join(root, "rtk"))

  const prepared = prepareShellCommand(command, root, env)
  assert.notEqual(prepared, command)
  assert.match(prepared, /eval/u)

  const result = spawnSync(MCP_CONFIG.shell.path, ["-c", prepared], {
    cwd: root,
    env,
    encoding: "utf8",
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, source)
})

test("RTK execution disables RTK-local tee, telemetry, and persistent tracking", async (t) => {
  const root = await fakeRtkRoot(t)
  useRtk(t, join(root, "rtk"))

  const prepared = prepareShellCommand("rtk env-probe", root, process.env)
  const result = spawnSync(MCP_CONFIG.shell.path, ["-c", prepared], { cwd: root, encoding: "utf8" })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, "0|1|/dev/null")
})

test("rewritten commands export the RTK path to child processes", async (t) => {
  const root = await fakeRtkRoot(t)
  const childTool = join(root, "child-tool")
  await writeFile(childTool, "#!/bin/sh\nexec rtk env-probe\n")
  await chmod(childTool, 0o755)
  useRtk(t, join(root, "rtk"))

  const env = { ...process.env, PATH: "/usr/bin:/bin" }
  const prepared = prepareShellCommand("child-tool", root, env)
  const result = spawnSync(MCP_CONFIG.shell.path, ["-c", prepared], {
    cwd: root,
    env,
    encoding: "utf8",
  })

  assert.equal(result.status, 0)
  assert.equal(result.stdout, "0|1|/dev/null")
})

test("RTK rewriting fails open when disabled, unavailable, unsupported, or opted out", async (t) => {
  const root = await fakeRtkRoot(t)
  const executable = join(root, "rtk")
  const previousEnabled = MCP_CONFIG.shell.rtk
  const previousExecutable = MCP_CONFIG.shell.rtkExecutable
  t.after(() => {
    MCP_CONFIG.shell.rtk = previousEnabled
    MCP_CONFIG.shell.rtkExecutable = previousExecutable
  })

  MCP_CONFIG.shell.rtk = false
  MCP_CONFIG.shell.rtkExecutable = executable
  assert.equal(prepareShellCommand("git status", root, process.env), "git status")

  MCP_CONFIG.shell.rtk = true
  MCP_CONFIG.shell.rtkExecutable = undefined
  assert.equal(prepareShellCommand("git status", root, process.env), "git status")

  MCP_CONFIG.shell.rtkExecutable = executable
  assert.equal(
    prepareShellCommand("RTK_DISABLED=1 git status", root, process.env),
    "RTK_DISABLED=1 git status"
  )
  assert.equal(prepareShellCommand("printf hello", root, process.env), "printf hello")
})

test("rewritten commands preserve persistent shell cwd and exported environment", {
  timeout: 10_000,
}, async (t) => {
  const root = await fakeRtkRoot(t)
  const child = join(root, "child")
  const init = spawnSync("git", ["init", "-q", child], { encoding: "utf8" })
  assert.equal(init.status, 0)
  useRtk(t, join(root, "rtk"))

  const shell = createShellSession({ cwd: root })
  t.after(async () => {
    await shell.close()
  })

  const first = await runToCompletion(
    shell,
    "rtk-state-1",
    "cd child && export SHELLBY_RTK_STATE=present && git status --short"
  )
  assert.equal(first.snapshot.exit_code, 0)

  const second = await runToCompletion(
    shell,
    "rtk-state-2",
    `printf '%s|%s' "$PWD" "$SHELLBY_RTK_STATE"`
  )
  assert.equal(second.output, `${await realpath(child)}|present`)
})

test("parallel RTK execution keeps the original command in caller-visible run metadata", {
  timeout: 10_000,
}, async (t) => {
  const root = await fakeRtkRoot(t)
  const child = join(root, "child")
  const init = spawnSync("git", ["init", "-q", child], { encoding: "utf8" })
  assert.equal(init.status, 0)
  useRtk(t, join(root, "rtk"))

  const shell = createShellSession({ cwd: root })
  t.after(async () => {
    await shell.close()
  })

  const result = await shell.runCommand({
    request_id: "rtk-parallel",
    commands: [{ command: "git status --short", cwd: "child" }],
    yield_time_ms: MCP_CONFIG.shell.maxWaitMs,
    max_output_tokens: MCP_CONFIG.shell.defaultOutputTokens,
  })
  assert.equal(result.commands?.[0]?.command, "git status --short")
})

function useRtk(t: TestContext, executable: string): void {
  const previousEnabled = MCP_CONFIG.shell.rtk
  const previousExecutable = MCP_CONFIG.shell.rtkExecutable
  MCP_CONFIG.shell.rtk = true
  MCP_CONFIG.shell.rtkExecutable = executable
  t.after(() => {
    MCP_CONFIG.shell.rtk = previousEnabled
    MCP_CONFIG.shell.rtkExecutable = previousExecutable
  })
}

async function fakeRtkRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellby-fake-rtk-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, "rtk")
  await writeFile(
    executable,
    `#!/bin/sh
set -eu

case "\${1:-}" in
  rewrite)
    command="\${2:-}"
    case "$command" in
      "cat fixture.txt") printf '%s' 'rtk read fixture.txt'; exit 3 ;;
      "rtk env-probe") printf '%s' 'rtk env-probe'; exit 3 ;;
      "child-tool") printf '%s' 'child-tool'; exit 3 ;;
      "cd child && export SHELLBY_RTK_STATE=present && git status --short")
        printf '%s' 'cd child && export SHELLBY_RTK_STATE=present && rtk git status --short'; exit 3 ;;
      "git status --short") printf '%s' 'rtk git status --short'; exit 3 ;;
      *) exit 1 ;;
    esac
    ;;
  read)
    shift
    exec /bin/cat "$@"
    ;;
  git)
    shift
    exec /usr/bin/git "$@"
    ;;
  env-probe)
    printf '%s' "$RTK_TEE|$RTK_TELEMETRY_DISABLED|$RTK_DB_PATH"
    ;;
  *)
    exit 1
    ;;
esac
`
  )
  await chmod(executable, 0o755)
  return root
}
