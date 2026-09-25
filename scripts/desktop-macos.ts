import { execFileSync, spawnSync } from "node:child_process"
import { chmod, cp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outputRoot = join(repositoryRoot, "dist-desktop")
const appPath = join(outputRoot, "OpenChatX.app")
const contentsPath = join(appPath, "Contents")
const macosPath = join(contentsPath, "MacOS")
const resourcesPath = join(contentsPath, "Resources")
const runtimePath = join(resourcesPath, "runtime")
const runtimeBinPath = join(runtimePath, "bin")
const cachePath = join(outputRoot, "cache")
const dmgPath = join(outputRoot, "OpenChatX.dmg")
const nodeVersion = process.versions.node

if (process.platform !== "darwin") {
  throw new Error("OpenChatX macOS Desktop packaging must run on macOS.")
}
if (process.arch !== "arm64" && process.arch !== "x64") {
  throw new Error(`Unsupported macOS architecture: ${process.arch}`)
}

const desktopCommand = process.argv[2] ?? "build"
if (desktopCommand === "build") {
  await buildDesktop()
} else if (desktopCommand === "install") {
  await buildDesktop()
  await installForCurrentUser()
} else if (desktopCommand === "uninstall") {
  await uninstallForCurrentUser()
} else {
  throw new Error(
    "Usage: npm run desktop:build | npm run desktop:install | npm run desktop:uninstall"
  )
}

async function buildDesktop(): Promise<void> {
  run("npm", ["run", "build"])
  run("npm", ["--prefix", "ui", "run", "build"])

  await rm(appPath, { recursive: true, force: true })
  await rm(dmgPath, { force: true })
  await mkdir(macosPath, { recursive: true })
  await mkdir(runtimeBinPath, { recursive: true })

  await Promise.all([
    copyTree("dist", join(runtimePath, "dist")),
    copyTree("ui/dist", join(runtimePath, "ui/dist")),
    copyTree("node_modules", join(runtimePath, "node_modules")),
    copyTree("store", join(runtimePath, "store")),
    copyTree("src/tools/start-here/prompts", join(runtimePath, "src/tools/start-here/prompts")),
    copyTree("vendor/apply-patch", join(runtimePath, "vendor/apply-patch")),
    copyTree("toolboxes", join(runtimePath, "defaults/toolboxes")),
  ])
  await copyFile("package.json", join(runtimePath, "package.json"))
  await writeDesktopConfig(join(runtimePath, ".openchatx/config.toml"))
  await copyFile(
    "desktop/runtime-defaults/mcp-servers.json",
    join(runtimePath, "defaults/mcp-servers.json")
  )
  await copyFile(
    "desktop/runtime-defaults/subagents.json",
    join(runtimePath, "defaults/subagents.json")
  )
  await removePackageBinDirectories(join(runtimePath, "node_modules"))

  const nodeExecutable = await ensureBundledNode()
  await cp(nodeExecutable, join(runtimeBinPath, "node"))
  await chmod(join(runtimeBinPath, "node"), 0o755)

  const tunnelClient = resolveExecutable("tunnel-client")
  await cp(tunnelClient, join(runtimeBinPath, "tunnel-client"))
  await chmod(join(runtimeBinPath, "tunnel-client"), 0o755)

  await buildIcon()
  await writeInfoPlist()
  await compileSwiftApp()

  await chmod(join(runtimePath, "vendor/apply-patch/apply_patch"), 0o755)
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath])
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath])

  await createDmg()
  console.log(`OpenChatX.app: ${appPath}`)
  console.log(`OpenChatX.dmg: ${dmgPath}`)
}

async function uninstallForCurrentUser(): Promise<void> {
  const destination = join(homedir(), "Applications", "OpenChatX.app")
  await rm(destination, { recursive: true, force: true })
  console.log(`Removed ${destination}`)
  console.log("User data in ~/Library/Application Support/OpenChatX was preserved.")
}

async function installForCurrentUser(): Promise<void> {
  const applications = join(homedir(), "Applications")
  const destination = join(applications, "OpenChatX.app")
  await mkdir(applications, { recursive: true })
  await rm(destination, { recursive: true, force: true })
  await cp(appPath, destination, { recursive: true })

  // Developer migration only: seed the user's existing local config outside the distributable app.
  const support = join(homedir(), "Library", "Application Support", "OpenChatX", "config")
  await mkdir(support, { recursive: true })
  await copyIfMissing(join(repositoryRoot, "mcp-servers.json"), join(support, "mcp-servers.json"))
  await copyIfMissing(join(repositoryRoot, "subagents.json"), join(support, "subagents.json"))

  console.log(`Installed OpenChatX.app at ${destination}`)
  console.log("Open it from Finder or Spotlight. npm and PM2 are not used by the app runtime.")
}

async function ensureBundledNode(): Promise<string> {
  const architecture = process.arch === "arm64" ? "arm64" : "x64"
  const folderName = `node-v${nodeVersion}-darwin-${architecture}`
  const extracted = join(cachePath, folderName)
  const executable = join(extracted, "bin", "node")
  try {
    await readFile(executable)
    return executable
  } catch {
    // Download the official self-contained Node macOS distribution for the target architecture.
  }

  await mkdir(cachePath, { recursive: true })
  const archive = join(cachePath, `${folderName}.tar.gz`)
  const url = `https://nodejs.org/dist/v${nodeVersion}/${folderName}.tar.gz`
  run("/usr/bin/curl", ["--fail", "--location", "--output", archive, url])
  run("/usr/bin/tar", ["-xzf", archive, "-C", cachePath])
  return executable
}

async function compileSwiftApp(): Promise<void> {
  const source = join(repositoryRoot, "desktop", "macos", "OpenChatXApp.swift")
  const output = join(macosPath, "OpenChatX")
  const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13`
  run("/usr/bin/swiftc", [
    "-O",
    "-target",
    target,
    "-framework",
    "AppKit",
    "-framework",
    "WebKit",
    "-framework",
    "Security",
    source,
    "-o",
    output,
  ])
  await chmod(output, 0o755)
}

async function buildIcon(): Promise<void> {
  const source = join(repositoryRoot, "ui", "public", "openchatx-mcp-icon.png")
  const iconset = join(outputRoot, "OpenChatX.iconset")
  await rm(iconset, { recursive: true, force: true })
  await mkdir(iconset, { recursive: true })

  const sizes: Array<[number, string]> = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ]
  for (const [size, name] of sizes) {
    run("/usr/bin/sips", ["-z", String(size), String(size), source, "--out", join(iconset, name)], {
      quiet: true,
    })
  }
  run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(resourcesPath, "OpenChatX.icns")])
  await rm(iconset, { recursive: true, force: true })
}

async function writeInfoPlist(): Promise<void> {
  const rawPackage = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"))
  if (!isRecord(rawPackage) || typeof rawPackage.version !== "string") {
    throw new Error("package.json is missing a valid version.")
  }
  const packageVersion = rawPackage.version
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>OpenChatX</string>
  <key>CFBundleExecutable</key><string>OpenChatX</string>
  <key>CFBundleIconFile</key><string>OpenChatX</string>
  <key>CFBundleIdentifier</key><string>com.openchatx.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>OpenChatX</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${packageVersion}</string>
  <key>CFBundleVersion</key><string>${packageVersion}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
`
  await writeFile(join(contentsPath, "Info.plist"), plist, "utf8")
}

async function writeDesktopConfig(destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(
    destination,
    [
      'state_dir = "~/.openchatx-mcp"',
      "port = 3333",
      "",
      "[shell]",
      'path = "/bin/zsh"',
      "rtk = false",
      "",
      "[tunnel]",
      'profile = "openchatx"',
      "health_port = 8080",
      "",
      "[mcp]",
      'tool_output = "compact"',
      "",
    ].join("\n"),
    "utf8"
  )
}

async function createDmg(): Promise<void> {
  const staging = join(outputRoot, "dmg")
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await cp(appPath, join(staging, "OpenChatX.app"), { recursive: true })
  await symlink("/Applications", join(staging, "Applications"))
  run("/usr/bin/hdiutil", [
    "create",
    "-volname",
    "OpenChatX",
    "-srcfolder",
    staging,
    "-ov",
    "-format",
    "UDZO",
    dmgPath,
  ])
  await rm(staging, { recursive: true, force: true })
}

async function removePackageBinDirectories(directory: string): Promise<void> {
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

async function copyTree(relativeSource: string, destination: string): Promise<void> {
  const source = join(repositoryRoot, relativeSource)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, verbatimSymlinks: false })
}

async function copyFile(relativeSource: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  await cp(join(repositoryRoot, relativeSource), destination)
}

async function copyIfMissing(source: string, destination: string): Promise<void> {
  try {
    await readFile(destination)
  } catch {
    await cp(source, destination)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resolveExecutable(name: string): string {
  const value = execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim()
  if (!value) throw new Error(`${name} executable was not found on PATH.`)
  return resolve(value)
}

function run(executable: string, args: string[], options: { quiet?: boolean } = {}): void {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
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
