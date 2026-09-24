import { join } from "node:path"
import process from "node:process"
import { createInterface } from "node:readline/promises"
import { MCP_CONFIG } from "../config.js"
import { OpenChatXAuthStore } from "./store.js"

const auth = new OpenChatXAuthStore(join(MCP_CONFIG.stateDir, "auth.json"))
const input = createInterface({ input: process.stdin, output: process.stdout })

console.warn(
  [
    "WARNING: resetting openchatx-mcp authentication will:",
    "- remove the currently bound ChatGPT identity",
    "- allow a new ChatGPT user to bind on the next tool call",
  ].join("\n")
)

try {
  const answer = (await input.question("Reset openchatx-mcp authentication? [y/N] "))
    .trim()
    .toLowerCase()
  if (answer !== "y" && answer !== "yes") {
    console.log("Authentication unchanged.")
    process.exitCode = 0
  } else {
    await auth.reset()
    console.log("openchatx-mcp authentication reset.")
  }
} finally {
  input.close()
}
