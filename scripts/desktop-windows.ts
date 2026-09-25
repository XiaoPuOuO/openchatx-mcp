import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

type WindowsArch = "x64" | "arm64"

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outputRoot = join(repositoryRoot, "dist-desktop")
const cacheRoot = join(outputRoot, "cache", "windows")
const command = process.argv[2] ?? "build"
const targetArch = parseArch(process.argv[3] ?? process.env.OPENCHATX_WINDOWS_ARCH ?? "x64")
const rid = targetArch === "arm64" ? "win-arm64" : "win-x64"
const nodeArch = targetArch === "arm64" ? "arm64" : "x64"
const tunnelArch = targetArch === "arm64" ? "arm64" : "amd64"
const bundleRoot = join(outputRoot, `windows-${targetArch}`)
const appRoot = join(bundleRoot, "OpenChatX")
const runtimeRoot = join(appRoot, "runtime")
const runtimeBin = join(runtimeRoot, "bin")
const shellPublish = join(bundleRoot, "shell-publish")
const zipPath = join(outputRoot, `OpenChatX-windows-${targetArch}.zip`)
const nodeVersion = process.versions.node
const packageVersion = await readPackageVersion()

if (command === "build") {
  await buildWindowsDesktop()
} else if (command === "installer") {
  if (process.platform !== "win32") {
    throw new Error("desktop:windows:installer must run on Windows with Inno Setup 6 installed.")
  }
  await buildWindowsDesktop()
  await buildInstaller()
} else if (command === "install") {
  if (process.platform !== "win32") {
    throw new Error("desktop:windows:install must run on Windows.")
  }
  await buildWindowsDesktop()
  await installForCurrentUser()
} else if (command === "uninstall") {
  if (process.platform !== "win32") {
    throw new Error("desktop:windows:uninstall must run on Windows.")
  }
  await uninstallForCurrentUser()
} else {
  throw new Error(
    "Usage: node --import tsx scripts/desktop-windows.ts build|installer|install|uninstall [x64|arm64]"
  )
}

async function buildWindowsDesktop(): Promise<void> {
  run("npm", ["run", "build"])
  run("npm", ["--prefix", "ui", "run", "build"])

  await rm(bundleRoot, { recursive: true, force: true })
  await rm(zipPath, { force: true })
  await mkdir(runtimeBin, { recursive: true })

  await Promise.all([
    copyTree("dist", join(runtimeRoot, "dist")),
    copyTree("ui/dist", join(runtimeRoot, "ui/dist")),
    copyTree("store", join(runtimeRoot, "store")),
    copyTree("src/tools/start-here/prompts", join(runtimeRoot, "src/tools/start-here/prompts")),
    copyFile(
      "src/tools/start-here/AGENTS.template.md",
      join(runtimeRoot, "src/tools/start-here/AGENTS.template.md")
    ),
    copyTree("toolboxes", join(runtimeRoot, "defaults/toolboxes")),
    copyFile(
      "desktop/runtime-defaults/mcp-servers.json",
      join(runtimeRoot, "defaults/mcp-servers.json")
    ),
    copyFile(
      "desktop/runtime-defaults/subagents.json",
      join(runtimeRoot, "defaults/subagents.json")
    ),
  ])

  await writeRuntimePackageJson(join(runtimeRoot, "package.json"))
  await writeWindowsDesktopConfig(join(runtimeRoot, ".openchatx", "config.toml"))
  await installWindowsRuntimeDependencies()

  const nodeExecutable = await ensureWindowsNode()
  await cp(nodeExecutable, join(runtimeBin, "node.exe"))

  const tunnelExecutable = await ensureWindowsTunnelClient()
  await cp(tunnelExecutable, join(runtimeBin, "tunnel-client.exe"))

  await publishWindowsShell()
  await copyPublishedShell()
  await prunePackagedRuntime()
  await signWindowsBinariesIfConfigured()
  await createPortableZip()

  console.log(`OpenChatX Windows ${targetArch}: ${appRoot}`)
  console.log(`Portable ZIP: ${zipPath}`)
}

async function buildInstaller(): Promise<void> {
  const compiler = resolveInnoSetupCompiler()
  const installerOutput = join(outputRoot, "windows-installer")
  await mkdir(installerOutput, { recursive: true })
  const allowedArch = targetArch === "arm64" ? "arm64" : "x64compatible"
  run(compiler, [
    `/DSourceDir=${appRoot}`,
    `/DOutputDir=${installerOutput}`,
    `/DAppVersion=${packageVersion}`,
    `/DTargetArch=${targetArch}`,
    `/DAllowedArch=${allowedArch}`,
    `/DInstallArch=${allowedArch}`,
    `/DIconFile=${join(repositoryRoot, "desktop", "windows", "OpenChatX.ico")}`,
    join(repositoryRoot, "desktop", "windows", "OpenChatX.iss"),
  ])
  console.log(`Installer: ${join(installerOutput, `OpenChatX-Setup-${targetArch}.exe`)}`)
}

async function installForCurrentUser(): Promise<void> {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) throw new Error("LOCALAPPDATA is not defined.")
  const destination = join(localAppData, "Programs", "OpenChatX")
  await rm(destination, { recursive: true, force: true })
  await mkdir(dirname(destination), { recursive: true })
  await cp(appRoot, destination, { recursive: true })
  console.log(`Installed OpenChatX at ${destination}`)
}

async function uninstallForCurrentUser(): Promise<void> {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) throw new Error("LOCALAPPDATA is not defined.")
  const destination = join(localAppData, "Programs", "OpenChatX")
  await rm(destination, { recursive: true, force: true })
  console.log(`Removed ${destination}`)
  console.log("User data under %LOCALAPPDATA%\\OpenChatX was preserved.")
}

async function installWindowsRuntimeDependencies(): Promise<void> {
  const env = {
    ...process.env,
    npm_config_os: "win32",
    npm_config_cpu: targetArch,
  }
  run(
    "npm",
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      "--prefix",
      runtimeRoot,
    ],
    { env }
  )
}

async function ensureWindowsNode(): Promise<string> {
  const folderName = `node-v${nodeVersion}-win-${nodeArch}`
  const extracted = join(cacheRoot, folderName)
  const executable = join(extracted, "node.exe")
  if (await exists(executable)) return executable

  await mkdir(cacheRoot, { recursive: true })
  const archive = join(cacheRoot, `${folderName}.zip`)
  if (!(await exists(archive))) {
    await download(`https://nodejs.org/dist/v${nodeVersion}/${folderName}.zip`, archive)
  }
  await extractZip(archive, cacheRoot)
  if (!(await exists(executable))) {
    throw new Error(`Downloaded Node archive did not contain ${executable}`)
  }
  return executable
}

async function ensureWindowsTunnelClient(): Promise<string> {
  const release = await fetchLatestTunnelRelease()

  const expectedSuffix = `-windows-${tunnelArch}.zip`
  const asset = release.assets.find(
    (candidate) =>
      candidate.name.startsWith("tunnel-client-v") &&
      candidate.name.endsWith(expectedSuffix) &&
      !candidate.name.includes("-runtime")
  )
  if (!asset) {
    throw new Error(
      `Latest tunnel-client release ${release.tag_name} has no full Windows ${tunnelArch} archive.`
    )
  }

  const releaseCache = join(cacheRoot, "tunnel-client", release.tag_name, targetArch)
  const archive = join(releaseCache, asset.name)
  const extracted = join(releaseCache, "extracted")
  await mkdir(releaseCache, { recursive: true })

  if (!(await exists(archive))) await download(asset.browser_download_url, archive)
  if (!(await exists(extracted))) {
    await mkdir(extracted, { recursive: true })
    await extractZip(archive, extracted)
  }

  const executable = await findFile(extracted, "tunnel-client.exe")
  if (!executable) {
    throw new Error(`Downloaded ${asset.name} did not contain tunnel-client.exe`)
  }
  return executable
}

async function publishWindowsShell(): Promise<void> {
  await rm(shellPublish, { recursive: true, force: true })
  run("dotnet", [
    "publish",
    "desktop/windows/OpenChatX.Windows.csproj",
    "-c",
    "Release",
    "-r",
    rid,
    "--self-contained",
    "true",
    "-p:PublishSingleFile=true",
    "-p:EnableWindowsTargeting=true",
    "-o",
    shellPublish,
  ])
}

async function copyPublishedShell(): Promise<void> {
  for (const entry of await readdir(shellPublish, { withFileTypes: true })) {
    if (entry.name.endsWith(".pdb") || entry.name.endsWith(".xml")) continue
    await cp(join(shellPublish, entry.name), join(appRoot, entry.name), {
      recursive: true,
      force: true,
    })
  }
}

async function writeRuntimePackageJson(destination: string): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"))
  if (!isRecord(raw) || !isRecord(raw.dependencies)) {
    throw new Error("package.json is missing dependencies.")
  }
  const dependencies = Object.fromEntries(
    Object.entries(raw.dependencies).filter(([name]) => name !== "pm2" && name !== "js-yaml")
  )
  await writeFile(
    destination,
    `${JSON.stringify(
      {
        name: raw.name,
        version: raw.version,
        private: true,
        type: "module",
        dependencies,
      },
      null,
      2
    )}\n`,
    "utf8"
  )
}

async function writeWindowsDesktopConfig(destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(
    destination,
    [
      'state_dir = "~/.openchatx-mcp"',
      "port = 3333",
      "",
      "[shell]",
      'path = "powershell.exe"',
      "rtk = false",
      "",
      "[tunnel]",
      'profile = "openchatx"',
      "health_port = 8080",
      "",
      "[mcp]",
      'tool_output = "compact"',
      "",
      "[tools]",
      "apply_patch = false",
      "",
    ].join("\n"),
    "utf8"
  )
}

async function prunePackagedRuntime(): Promise<void> {
  const modules = join(runtimeRoot, "node_modules")
  await removePackageBinDirectories(modules)

  const nodePty = join(modules, "node-pty")
  const targetPrebuild = targetArch === "arm64" ? "win32-arm64" : "win32-x64"
  for (const entry of [
    "binding.gyp",
    "deps",
    "scripts",
    "src",
    "third_party",
    "typings",
    "README.md",
  ]) {
    await rm(join(nodePty, entry), { recursive: true, force: true })
  }
  for (const entry of ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]) {
    if (entry !== targetPrebuild) {
      await rm(join(nodePty, "prebuilds", entry), { recursive: true, force: true })
    }
  }

  await removeRuntimeMetadata(modules)
}

async function removePackageBinDirectories(directory: string): Promise<void> {
  if (!(await exists(directory))) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const child = join(directory, entry.name)
    if (entry.name === ".bin") {
      await rm(child, { recursive: true, force: true })
      continue
    }
    await removePackageBinDirectories(child)
  }
}

async function removeRuntimeMetadata(directory: string): Promise<void> {
  if (!(await exists(directory))) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name)
    if (entry.isDirectory()) {
      await removeRuntimeMetadata(child)
      continue
    }
    if (!entry.isFile()) continue
    if (
      entry.name.endsWith(".d.ts") ||
      entry.name.endsWith(".d.mts") ||
      entry.name.endsWith(".d.cts") ||
      entry.name.endsWith(".map") ||
      /^readme(?:\..*)?$/iu.test(entry.name) ||
      /^changelog(?:\..*)?$/iu.test(entry.name)
    ) {
      await rm(child, { force: true })
    }
  }
}

async function signWindowsBinariesIfConfigured(): Promise<void> {
  if (process.platform !== "win32") return
  const thumbprint = process.env.OPENCHATX_WINDOWS_CERT_SHA1?.trim()
  if (!thumbprint) return

  const signtool = process.env.SIGNTOOL_PATH?.trim() || "signtool.exe"
  run(signtool, [
    "sign",
    "/sha1",
    thumbprint,
    "/fd",
    "SHA256",
    "/tr",
    "http://timestamp.digicert.com",
    "/td",
    "SHA256",
    join(appRoot, "OpenChatX.exe"),
  ])
}

async function createPortableZip(): Promise<void> {
  await rm(zipPath, { force: true })
  if (process.platform === "win32") {
    run("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path ${psQuote(appRoot)} -DestinationPath ${psQuote(zipPath)} -Force`,
    ])
    return
  }
  if (process.platform === "darwin") {
    run("/usr/bin/ditto", ["-c", "-k", "--keepParent", appRoot, zipPath])
    return
  }
  run("zip", ["-qry", zipPath, basename(appRoot)], { cwd: dirname(appRoot) })
}

async function extractZip(archive: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  if (process.platform === "win32") {
    run("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath ${psQuote(archive)} -DestinationPath ${psQuote(destination)} -Force`,
    ])
    return
  }
  run("unzip", ["-q", "-o", archive, "-d", destination])
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": "OpenChatX-Desktop-Packager" },
    redirect: "follow",
  })
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
}

async function fetchLatestTunnelRelease(): Promise<{
  tag_name: string
  assets: Array<{ name: string; browser_download_url: string }>
}> {
  const url = "https://api.github.com/repos/openai/tunnel-client/releases/latest"
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "OpenChatX-Desktop-Packager",
    },
  })
  if (!response.ok) throw new Error(`Request failed ${response.status}: ${url}`)
  const value: unknown = await response.json()
  if (!isRecord(value) || typeof value.tag_name !== "string" || !Array.isArray(value.assets)) {
    throw new Error("Unexpected tunnel-client release response.")
  }
  const assets = value.assets.flatMap((item) => {
    if (
      isRecord(item) &&
      typeof item.name === "string" &&
      typeof item.browser_download_url === "string"
    ) {
      return [{ name: item.name, browser_download_url: item.browser_download_url }]
    }
    return []
  })
  return { tag_name: value.tag_name, assets }
}

async function findFile(directory: string, filename: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) return child
    if (entry.isDirectory()) {
      const nested = await findFile(child, filename)
      if (nested) return nested
    }
  }
  return undefined
}

async function copyTree(relativeSource: string, destination: string): Promise<void> {
  const source = join(repositoryRoot, relativeSource)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, verbatimSymlinks: false })
}

async function copyFile(relativeSource: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  await cp(join(repositoryRoot, relativeSource), destination)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    return isFsError(error, "ENOENT") ? false : Promise.reject(error)
  }
}

async function readPackageVersion(): Promise<string> {
  const raw: unknown = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"))
  if (!isRecord(raw) || typeof raw.version !== "string" || !raw.version.trim()) {
    throw new Error("package.json is missing a valid version.")
  }
  return raw.version
}

function resolveInnoSetupCompiler(): string {
  const configured = process.env.INNO_SETUP_COMPILER?.trim()
  if (configured) return configured

  const candidates = [
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Inno Setup 6", "ISCC.exe"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return "ISCC.exe"
}

function parseArch(value: string): WindowsArch {
  if (value === "x64" || value === "arm64") return value
  throw new Error(`Unsupported Windows architecture: ${value}. Use x64 or arm64.`)
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function run(
  executable: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv
    cwd?: string
    quiet?: boolean
  } = {}
): void {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "ignore", "pipe"] : "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr : ""
    throw new Error(
      `${basename(executable)} failed with exit code ${result.status ?? 1}${stderr ? `: ${stderr}` : ""}`
    )
  }
}
