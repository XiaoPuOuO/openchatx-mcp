import { execFileSync, spawnSync } from "node:child_process"
import { chmod, cp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
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
const notarizationZipPath = join(outputRoot, "OpenChatX-notarization.zip")
const nodeVersion = process.versions.node
const tunnelClientVersion = process.env.OPENCHATX_TUNNEL_CLIENT_VERSION?.trim() || "v0.0.15"
const notaryProfile = process.env.OPENCHATX_NOTARY_PROFILE?.trim() || "openchatx-notary"

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
} else if (desktopCommand === "notarize") {
  await buildDesktop()
  await notarizeDesktop()
} else {
  throw new Error(
    "Usage: npm run desktop:build | npm run desktop:install | npm run desktop:uninstall | npm run desktop:notarize"
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
    copyFile(
      "src/tools/start-here/AGENTS.template.md",
      join(runtimePath, "src/tools/start-here/AGENTS.template.md")
    ),
    copyTree("vendor/apply-patch", join(runtimePath, "vendor/apply-patch")),
    copyTree("toolboxes", join(runtimePath, "defaults/toolboxes")),
  ])
  await writeRuntimePackageJson(join(runtimePath, "package.json"))
  await writeDesktopConfig(join(runtimePath, ".openchatx/config.toml"))
  await copyFile(
    "desktop/runtime-defaults/mcp-servers.json",
    join(runtimePath, "defaults/mcp-servers.json")
  )
  await copyFile(
    "desktop/runtime-defaults/subagents.json",
    join(runtimePath, "defaults/subagents.json")
  )
  pruneDevelopmentDependencies()
  await prunePackagedRuntime()

  const nodeExecutable = await ensureBundledNode()
  await cp(nodeExecutable, join(runtimeBinPath, "node"))
  await chmod(join(runtimeBinPath, "node"), 0o755)

  const tunnelClient = await ensureBundledTunnelClient()
  await cp(tunnelClient, join(runtimeBinPath, "tunnel-client"))
  await chmod(join(runtimeBinPath, "tunnel-client"), 0o755)

  await buildIcon()
  await writeInfoPlist()
  await compileSwiftApp()

  await chmod(join(runtimePath, "vendor/apply-patch/apply_patch"), 0o755)
  const signingIdentity = resolveCodesignIdentity()
  if (signingIdentity !== "-") await signNestedMachOBinaries(signingIdentity)
  signApp(signingIdentity)

  await createDmg()
  signDmg(signingIdentity)
  console.log(
    signingIdentity === "-"
      ? "Signing: ad-hoc (set OPENCHATX_CODESIGN_IDENTITY or install one Developer ID Application identity for release signing)"
      : `Signing: ${signingIdentity}`
  )
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

async function ensureBundledTunnelClient(): Promise<string> {
  const architecture = process.arch === "arm64" ? "arm64" : "amd64"
  const assetName = `tunnel-client-${tunnelClientVersion}-darwin-${architecture}.zip`
  const releaseCache = join(cachePath, "tunnel-client", tunnelClientVersion, architecture)
  const archive = join(releaseCache, assetName)
  const extracted = join(releaseCache, "extracted")
  const executable = join(extracted, "tunnel-client")
  try {
    await stat(executable)
    return executable
  } catch {
    // Download and extract the pinned official tunnel-client release for this architecture.
  }

  await mkdir(extracted, { recursive: true })
  const url = `https://github.com/openai/tunnel-client/releases/download/${tunnelClientVersion}/${assetName}`
  run("/usr/bin/curl", ["--fail", "--location", "--output", archive, url])
  run("/usr/bin/unzip", ["-q", "-o", archive, "-d", extracted])
  await chmod(executable, 0o755)
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

async function writeRuntimePackageJson(destination: string): Promise<void> {
  const raw = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"))
  if (!isRecord(raw) || !isRecord(raw.dependencies)) {
    throw new Error("package.json is missing dependencies.")
  }
  const dependencies = Object.fromEntries(
    Object.entries(raw.dependencies).filter(([name]) => name !== "pm2" && name !== "js-yaml")
  )
  const payload = JSON.stringify(
    {
      name: raw.name,
      version: raw.version,
      private: true,
      type: "module",
      dependencies,
    },
    null,
    2
  )

  await writeFile(destination, `${payload}\n`, "utf8")
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
  await rm(dmgPath, { force: true })
  await mkdir(staging, { recursive: true })
  await cp(appPath, join(staging, "OpenChatX.app"), { recursive: true })
  await symlink("/Applications", join(staging, "Applications"))
  const hdiutilArgs = [
    "create",
    "-volname",
    "OpenChatX",
    "-srcfolder",
    staging,
    "-ov",
    "-format",
    "UDZO",
    dmgPath,
  ]
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await rm(dmgPath, { force: true })
      run("/usr/bin/hdiutil", hdiutilArgs)
      lastError = undefined
      break
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))
    }
  }
  await rm(staging, { recursive: true, force: true })
  if (lastError) throw lastError
}

async function notarizeDesktop(): Promise<void> {
  const signingIdentity = resolveCodesignIdentity()
  if (signingIdentity === "-") {
    throw new Error("Developer ID Application signing identity is required for notarization.")
  }

  await rm(notarizationZipPath, { force: true })
  run("/usr/bin/ditto", ["-c", "-k", "--keepParent", appPath, notarizationZipPath])
  run("/usr/bin/xcrun", [
    "notarytool",
    "submit",
    notarizationZipPath,
    "--keychain-profile",
    notaryProfile,
    "--wait",
  ])
  run("/usr/bin/xcrun", ["stapler", "staple", appPath])
  run("/usr/bin/xcrun", ["stapler", "validate", appPath])

  await createDmg()
  signDmg(signingIdentity)
  run("/usr/bin/xcrun", [
    "notarytool",
    "submit",
    dmgPath,
    "--keychain-profile",
    notaryProfile,
    "--wait",
  ])
  run("/usr/bin/xcrun", ["stapler", "staple", dmgPath])
  run("/usr/bin/xcrun", ["stapler", "validate", dmgPath])
  run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath])

  console.log(`Notarization complete using Keychain profile ${JSON.stringify(notaryProfile)}.`)
}

function resolveCodesignIdentity(): string {
  const configured = process.env.OPENCHATX_CODESIGN_IDENTITY?.trim()
  if (configured) return configured

  const output = execFileSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  })
  const identities = [...output.matchAll(/"([^"]*Developer ID Application:[^"]+)"/gu)].map(
    (match) => match[1]
  )
  if (identities.length === 1 && identities[0]) return identities[0]
  if (identities.length > 1) {
    throw new Error(
      "Multiple Developer ID Application identities are installed. Set OPENCHATX_CODESIGN_IDENTITY explicitly."
    )
  }
  return "-"
}

function pruneDevelopmentDependencies(): void {
  run("npm", ["prune", "--omit=dev", "--ignore-scripts", "--prefix", runtimePath], { quiet: true })
}

async function prunePackagedRuntime(): Promise<void> {
  const modules = join(runtimePath, "node_modules")
  await removePackageBinDirectories(modules)
  await rm(join(runtimePath, "package-lock.json"), { force: true })

  const nodePty = join(modules, "node-pty")
  const targetPrebuild = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64"
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

async function removeRuntimeMetadata(directory: string): Promise<void> {
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

async function signNestedMachOBinaries(identity: string): Promise<void> {
  const candidates = await collectNativeCodeCandidates(resourcesPath)
  let signed = 0
  let preserved = 0

  for (const candidate of candidates) {
    if (!isMachO(candidate)) continue
    if (hasReleaseSignature(candidate)) {
      preserved += 1
      continue
    }
    run(
      "/usr/bin/codesign",
      ["--force", "--options", "runtime", "--timestamp", "--sign", identity, candidate],
      { quiet: true }
    )
    signed += 1
  }

  console.log(
    `Nested code signing: ${signed} signed with OpenChatX Developer ID, ${preserved} existing Developer ID signatures preserved.`
  )
}

async function collectNativeCodeCandidates(directory: string): Promise<string[]> {
  const candidates: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name)
    if (entry.isDirectory()) {
      candidates.push(...(await collectNativeCodeCandidates(child)))
      continue
    }
    if (!entry.isFile()) continue

    const info = await stat(child)
    if (
      (info.mode & 0o111) !== 0 ||
      child.endsWith(".node") ||
      child.endsWith(".dylib") ||
      child.endsWith(".so") ||
      child.endsWith(".bundle")
    ) {
      candidates.push(child)
    }
  }
  return candidates
}

function isMachO(path: string): boolean {
  const result = spawnSync("/usr/bin/file", ["-b", path], { encoding: "utf8" })
  return result.status === 0 && result.stdout.includes("Mach-O")
}

function hasReleaseSignature(path: string): boolean {
  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", path], {
    encoding: "utf8",
  })
  const details = `${result.stdout ?? ""}${result.stderr ?? ""}`
  return (
    result.status === 0 &&
    details.includes("Authority=Developer ID Application:") &&
    details.includes("runtime") &&
    details.includes("Timestamp=")
  )
}

function signApp(identity: string): void {
  const args = ["--force", "--deep"]
  if (identity !== "-") args.push("--options", "runtime", "--timestamp")
  args.push("--sign", identity, appPath)
  run("/usr/bin/codesign", args)
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath])
}

function signDmg(identity: string): void {
  if (identity === "-") return
  run("/usr/bin/codesign", ["--force", "--timestamp", "--sign", identity, dmgPath])
  run("/usr/bin/codesign", ["--verify", "--verbose=2", dmgPath])
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
