import { cpus, freemem, hostname, platform, release, totalmem } from "node:os"
import process from "node:process"

import { defineTool, z } from "openchatx-mcp/toolbox"

export default defineTool({
  name: "system-info",
  description: "Report basic local machine information.",
  inputSchema: z.object({}),
  async execute() {
    return {
      structuredContent: {
        hostname: hostname(),
        platform: platform(),
        release: release(),
        architecture: process.arch,
        cpu_count: cpus().length,
        total_memory_bytes: totalmem(),
        free_memory_bytes: freemem(),
      },
      content: [],
    }
  },
})
