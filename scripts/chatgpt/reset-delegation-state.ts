import { rmSync } from "node:fs"
import { join } from "node:path"

import { MCP_CONFIG } from "../../src/config.js"

const stateDatabasePath: string = join(MCP_CONFIG.stateDir, "subagents.sqlite")
rmSync(stateDatabasePath, { force: true })
rmSync(`${stateDatabasePath}-shm`, { force: true })
rmSync(`${stateDatabasePath}-wal`, { force: true })
console.log(`Reset subagent state: ${stateDatabasePath}`)
