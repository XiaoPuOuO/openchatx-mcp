import assert from "node:assert/strict"
import test from "node:test"

import { buildMcpInstructions } from "../src/config.js"

test("MCP instructions route ordinary file search to dedicated tools", () => {
  const instructions = buildMcpInstructions()

  assert.match(instructions, /Filename or path discovery: use glob/u)
  assert.match(instructions, /Do not use bash find/u)
  assert.match(instructions, /Search inside file contents: use grep/u)
  assert.match(instructions, /Do not use bash grep or rg/u)
  assert.match(instructions, /Use bash for genuine shell work/u)
})
