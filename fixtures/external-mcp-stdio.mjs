import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { z } from "zod"

serveStdio(() => {
  const server = new McpServer({ name: "external-stdio-fixture", version: "1.0.0" })
  server.registerTool(
    "echo",
    {
      description: "Echo a value from the stdio fixture.",
      inputSchema: z.object({ value: z.string() }),
    },
    async ({ value }) => ({
      content: [{ type: "text", text: `stdio:${value}` }],
      structuredContent: { value, transport: "stdio" },
    })
  )
  return server
})
