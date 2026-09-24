import process from "node:process"
import {
  buildStartHereInstructions,
  discoverPromptModes,
} from "../src/tools/start-here/start-here.js"

const mode = process.argv[2]
const modes = discoverPromptModes()

if (!mode || !modes.includes(mode)) {
  console.error(`Usage: npm run prompt -- <mode>\nModes: ${modes.join(", ")}`)
  process.exitCode = 2
} else {
  console.log(await buildStartHereInstructions(mode))
}
