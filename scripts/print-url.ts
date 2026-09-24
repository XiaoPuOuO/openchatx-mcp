import { MCP_CONFIG } from "../src/config.js"

console.log(`Local MCP target: http://${MCP_CONFIG.host}:${MCP_CONFIG.port}/mcp`)
console.log(`Tunnel profile: ${MCP_CONFIG.tunnel.profile}`)
console.log(`Tunnel UI: http://127.0.0.1:${MCP_CONFIG.tunnel.healthPort}/ui`)
console.log(`OpenChatX UI: http://${MCP_CONFIG.host}:${MCP_CONFIG.port}/ui`)
