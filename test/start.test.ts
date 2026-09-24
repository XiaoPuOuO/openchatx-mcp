import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { delimiter, join } from "node:path"
import process from "node:process"
import test, { type TestContext } from "node:test"
import { tempDir } from "./helpers/temp.js"

// Run the real entrypoint in a disposable repository with fake external commands, never the live PM2 daemon.
async function runStartup(
  t: TestContext,
  options: {
    restart?: boolean
    hard?: boolean
    failCommand?: string
    pm2Args?: string[]
    fromShellby?: boolean
    healthInstance?: string
    ngrokEnabled?: boolean
    existingTunnel?: boolean
  } = {}
) {
  const root = await realpath(await tempDir(t, "shellby-start-"))
  for (const directory of ["scripts", "src", "bin", "node_modules/.bin"])
    await mkdir(join(root, directory), { recursive: true })
  await writeFile(join(root, "package.json"), '{"type":"module"}\n')
  await copyFile(new URL("../scripts/start.ts", import.meta.url), join(root, "scripts", "start.ts"))
  await copyFile(new URL("../scripts/pm2.ts", import.meta.url), join(root, "scripts", "pm2.ts"))
  await writeFile(
    join(root, "src", "config.ts"),
    `export const MCP_CONFIG = ${JSON.stringify({ host: "127.0.0.1", port: 3334, instanceId: "fixture", stateDir: join(root, "state"), workspace: root, ngrok: { enabled: options.ngrokEnabled ?? true }, shell: { rtk: false }, tools: {} })}`
  )
  await writeFile(
    join(root, "scripts", "preflight.ts"),
    `export async function checkPublicRuntime(ngrokEnabled) { if(ngrokEnabled !== ${options.ngrokEnabled ?? true}) throw new Error("wrong ngrok preflight mode"); return { errors: [] }; }
export function checkRtkRuntime() {}
export function printPreflightErrors() {}`
  )
  await writeFile(
    join(root, "scripts", "print-url.ts"),
    options.ngrokEnabled === false
      ? 'console.log("http://127.0.0.1:3334/mcp")'
      : 'console.log("https://test.invalid/mcp")'
  )
  await writeFile(join(root, "agent-commands.yaml"), "previous audit\n")
  await writeFile(join(root, "calls.jsonl"), "")

  for (const [command, path] of [
    ["npm", "bin/npm"],
    ["pm2", "node_modules/.bin/pm2"],
  ]) {
    await writeFile(
      join(root, path!),
      `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "calls.jsonl"))}, JSON.stringify({
  command: ${JSON.stringify(command)}, args, auditExists: existsSync(${JSON.stringify(join(root, "agent-commands.yaml"))}),
  pm2Home: process.env.PM2_HOME, cwd: process.cwd()
}) + "\\n");
if ([${JSON.stringify(command)} + " " + args[0], ${JSON.stringify(command)} + " " + args.join(" ")].includes(process.env.START_TEST_FAIL)) process.exit(7);
if (${JSON.stringify(command)} === "pm2" && args[0] === "jlist") console.log(${JSON.stringify(JSON.stringify(options.existingTunnel ? [{ name: "openchatx-ngrok" }, { name: "unrelated-app" }] : []))});
`,
      { mode: 0o755 }
    )
  }

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      `data:text/javascript,globalThis.fetch=async(url)=>{if(url!=="http://127.0.0.1:3334/healthz")throw new Error("wrong health port");return {ok:true,headers:new Headers({"x-openchatx-instance":${JSON.stringify(options.healthInstance ?? "fixture")}})}}`,
      join(root, "scripts", options.pm2Args ? "pm2.ts" : "start.ts"),
      ...(options.pm2Args ?? [
        ...(options.restart ? ["--restart"] : []),
        ...(options.hard ? ["--hard"] : []),
      ]),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
        START_TEST_FAIL: options.failCommand ?? "",
        PM2_HOME: join(root, "unrelated-pm2"),
        name: options.fromShellby ? "openchatx-mcp" : undefined,
        pm_exec_path: options.fromShellby ? join(root, "dist", "index.js") : undefined,
      },
      encoding: "utf8",
      timeout: 15_000,
    }
  )
  assert.ifError(result.error)
  const calls = (await readFile(join(root, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const { pm2Home, cwd, ...call } = JSON.parse(line) as {
        command: string
        args: string[]
        auditExists: boolean
        pm2Home: string
        cwd: string
      }
      if (call.command === "pm2") {
        assert.equal(
          pm2Home,
          join(root, "state", "pm2"),
          "every PM2 call must use the configured Shellby state directory"
        )
        assert.equal(cwd, root, "PM2 resolves ecosystem paths from the repository")
      }
      return call
    })
  return { root, result, calls }
}

for (const fromShellby of [false, true]) {
  test(`ordinary restart ${fromShellby ? "inside Shellby" : "from a terminal"} keeps PM2 and reloads MCP last`, async (t) => {
    const { result, calls } = await runStartup(t, { restart: true, fromShellby })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls, [
      { command: "npm", args: ["run", "build"], auditExists: true },
      {
        command: "pm2",
        args: [
          "startOrReload",
          "ecosystem.config.cjs",
          "--only",
          "openchatx-ngrok",
          "--update-env",
        ],
        auditExists: false,
      },
      {
        command: "pm2",
        args: ["startOrReload", "ecosystem.config.cjs", "--only", "openchatx-mcp", "--update-env"],
        auditExists: false,
      },
    ])
    assert.match(result.stdout, /https:\/\/test.invalid\/mcp/u)
  })
}

for (const existingTunnel of [false, true]) {
  test(`local restart ${existingTunnel ? "removes an existing tunnel" : "works without a tunnel"} before reloading MCP`, async (t) => {
    const { result, calls } = await runStartup(t, {
      restart: true,
      ngrokEnabled: false,
      existingTunnel,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(
      calls.map(({ command, args }) => [command, ...args]),
      [
        ["npm", "run", "build"],
        ["pm2", "jlist", "--silent"],
        ...(existingTunnel ? [["pm2", "delete", "openchatx-ngrok"]] : []),
        ["pm2", "startOrReload", "ecosystem.config.cjs", "--only", "openchatx-mcp", "--update-env"],
      ]
    )
    assert.match(result.stdout, /ngrok: disabled \(local only\)/u)
    assert.match(result.stdout, /http:\/\/127.0.0.1:3334\/mcp/u)
  })
}

for (const failCommand of ["pm2 jlist", "pm2 delete openchatx-ngrok"]) {
  test(`local startup stops when tunnel cleanup fails at ${failCommand}`, async (t) => {
    const { result, calls } = await runStartup(t, {
      ngrokEnabled: false,
      existingTunnel: true,
      failCommand,
    })
    assert.equal(result.status, 7)
    assert.ok(!calls.some(({ args }) => args.includes("startOrReload")))
    assert.ok(!result.stdout.includes("local only"))
  })
}

test("hard restart with ngrok disabled recreates only MCP", async (t) => {
  const { result, calls } = await runStartup(t, {
    hard: true,
    ngrokEnabled: false,
    existingTunnel: true,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    [
      ["npm", "run", "build"],
      ["pm2", "kill"],
      ["pm2", "startOrReload", "ecosystem.config.cjs", "--only", "openchatx-mcp", "--update-env"],
    ]
  )
})

test("hard restart rebuilds before replacing PM2 and clears the audit only after shutdown", async (t) => {
  const { result, calls } = await runStartup(t, { restart: true, hard: true })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls, [
    { command: "npm", args: ["run", "build"], auditExists: true },
    { command: "pm2", args: ["kill"], auditExists: true },
    {
      command: "pm2",
      args: ["startOrReload", "ecosystem.config.cjs", "--only", "openchatx-ngrok", "--update-env"],
      auditExists: false,
    },
    {
      command: "pm2",
      args: ["startOrReload", "ecosystem.config.cjs", "--only", "openchatx-mcp", "--update-env"],
      auditExists: false,
    },
  ])
})

test("hard restart inside Shellby fails before build or shutdown", async (t) => {
  const { root, result, calls } = await runStartup(t, {
    restart: true,
    hard: true,
    fromShellby: true,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /healthy Terminal.app session/u)
  assert.deepEqual(calls, [])
  assert.equal(await readFile(join(root, "agent-commands.yaml"), "utf8"), "previous audit\n")
})

test("ordinary startup keeps the PM2 daemon and audit log", async (t) => {
  const { result, calls } = await runStartup(t)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(calls.every(({ auditExists }) => auditExists))
  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    [
      ["npm", "run", "build"],
      ["pm2", "startOrReload", "ecosystem.config.cjs", "--only", "openchatx-ngrok", "--update-env"],
      ["pm2", "startOrReload", "ecosystem.config.cjs", "--only", "openchatx-mcp", "--update-env"],
    ]
  )
})

test("startup does not report success for another copy on the configured port", async (t) => {
  const { result } = await runStartup(t, { healthInstance: "other-copy" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /another instance using port 3334/u)
  assert.ok(!result.stdout.includes("https://test.invalid/mcp"))
})

test("restart reloads services in tunnel then MCP order", async (t) => {
  const { result, calls } = await runStartup(t, {
    restart: true,
    fromShellby: true,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    [
      ["npm", "run", "build"],
      ["pm2", "startOrReload", "ecosystem.config.cjs", "--only", "openchatx-ngrok", "--update-env"],
      ["pm2", "startOrReload", "ecosystem.config.cjs", "--only", "openchatx-mcp", "--update-env"],
    ]
  )
})

test("an in-shell build failure leaves services and the audit intact", async (t) => {
  const { root, result, calls } = await runStartup(t, {
    restart: true,
    failCommand: "npm run",
    fromShellby: true,
  })
  assert.equal(result.status, 7)
  assert.deepEqual(calls, [{ command: "npm", args: ["run", "build"], auditExists: true }])
  assert.equal(await readFile(join(root, "agent-commands.yaml"), "utf8"), "previous audit\n")
})

test("a failed tunnel reload leaves MCP running", async (t) => {
  const { result, calls } = await runStartup(t, { restart: true, failCommand: "pm2 startOrReload" })
  assert.equal(result.status, 7)
  assert.equal(calls.at(-1)?.args[3], "openchatx-ngrok")
  assert.ok(calls.every(({ args }) => !args.includes("openchatx-mcp")))
})

for (const failure of ["npm run", "pm2 kill"]) {
  test(`hard restart stops after ${failure} fails and preserves the audit log`, async (t) => {
    const { root, result, calls } = await runStartup(t, {
      restart: true,
      hard: true,
      failCommand: failure,
    })
    assert.equal(result.status, 7)
    assert.equal(calls.length, failure === "npm run" ? 1 : 2)
    assert.equal(await readFile(join(root, "agent-commands.yaml"), "utf8"), "previous audit\n")
  })
}

test("PM2 operational commands use Shellby's dedicated daemon and preserve CLI arguments", async (t) => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as { scripts: Record<string, string> }
  for (const name of ["stop", "status", "logs", "pm2"]) {
    const command = packageJson.scripts[name]!
    assert.ok(command.startsWith("node --import tsx scripts/pm2.ts"))
    const args = command.split(" ").slice(4)
    if (name === "pm2") args.push("jlist")
    if (name === "logs") args.push("--lines", "20", "--nostream")
    const { result, calls } = await runStartup(t, { pm2Args: args })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls, [{ command: "pm2", args, auditExists: true }])
  }
})
