import { createInterface } from "node:readline/promises"

import { ShellbyAuthStore } from "./auth.js"

const auth = new ShellbyAuthStore()
const input = createInterface({ input: process.stdin, output: process.stdout })

console.warn(
  [
    "WARNING: resetting Shellby MCP authentication will:",
    "- remove the currently bound ChatGPT identity",
    "- allow a new ChatGPT user to bind on the next tool call",
  ].join("\n")
)

try {
  const answer = (await input.question("Reset Shellby MCP authentication? [y/N] ")).trim().toLowerCase()
  if (answer !== "y" && answer !== "yes") {
    console.log("Authentication unchanged.")
    process.exitCode = 0
  } else {
    await auth.reset()
    console.log("Shellby MCP authentication reset.")
  }
} finally {
  input.close()
}
