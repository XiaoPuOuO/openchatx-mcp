import { dirname } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import {
  desktopInstallPlan,
  installDesktopLauncher,
  uninstallDesktopLauncher,
} from "./desktop-runtime.js"

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const command = process.argv[2] ?? "install"
const plan = desktopInstallPlan(repositoryRoot)

if (command === "install") {
  await installDesktopLauncher(plan)
  console.log(`OpenChatX Desktop launcher installed at ${plan.launcherPath}`)
} else if (command === "uninstall") {
  await uninstallDesktopLauncher(plan)
  console.log("OpenChatX Desktop launcher removed.")
} else {
  console.error("Usage: npm run desktop:install | npm run desktop:uninstall")
  process.exit(1)
}
