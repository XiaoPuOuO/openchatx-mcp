import { rmSync } from "node:fs"
import { join } from "node:path"

import { MCP_CONFIG } from "../src/config.ts"

const path = join(MCP_CONFIG.stateDir, "subagents.sqlite")
rmSync(path, { force: true })
rmSync(`${path}-shm`, { force: true })
rmSync(`${path}-wal`, { force: true })
console.log(`Reset subagent state: ${path}`)
