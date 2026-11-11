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
  assert.match(instructions, /Mandatory Skill routing/u)
  assert.match(instructions, /for each new task_id/u)
  assert.match(instructions, /resolve Project routing FIRST, then Skill routing/u)
  assert.match(instructions, /omit name/u)
  assert.match(instructions, /reason=user-forbids-skills/u)
})
