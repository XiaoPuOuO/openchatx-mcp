---
summary: "How the registerTool monkeypatch connects tool registration to Shellby's dispatch pipeline, including installation order, validation, notices, and audit."
paths:
  - src/mcp/server-factory.ts
  - src/mcp/tool-registration-boundary.ts
  - src/mcp/tool-schema-presentation.ts
  - src/mcp/tool-output.ts
  - src/server/http-server.ts
  - src/server/audit/audit-request.ts
---

# MCP Tool Registration Boundary

## What the Monkeypatch Does

Shellby replaces `registerTool` on each newly created `McpServer` instance so registrations pass through Shellby's execution policy. `installToolRegistrationBoundary()` captures the original SDK method and installs `boundaryRegisterTool` using `Reflect.set(server, "registerTool", boundaryRegisterTool)`. The SDK prototype remains unchanged.

A tool module calls `server.registerTool(name, config, handler)` in the familiar SDK form. The boundary prepares the public schema and gives the SDK a wrapper that closes over that handler and its execution metadata. The captured SDK method is called through `Reflect.apply` with the original server as its receiver. Each wrapper invokes its own handler through initialization gating, result projection, notices, and audit/observer hooks.

## Registration and Execution

Registration follows this order:

1. The factory creates a fresh MCP server.
2. The boundary replaces that instance's registration method.
3. Each capability registers its tool through the boundary.
4. Schema presentation prepares the configuration, and the original SDK method registers the wrapped handler.

For each tool call:

1. The SDK resolves the tool and validates its input.
2. The wrapper associates the request's audit entry and checks initialization.
3. Observation starts, and the original handler receives the SDK-validated arguments and context.
4. The boundary finishes observation, projects the result, appends notices, and finishes the audit entry.
5. The result returns to the SDK, which validates any published output schema.

The wrapper preserves both SDK callback conventions: handlers with an input schema receive `(args, context)`; handlers without an input schema receive `(context)`. Schema preparation preserves each tool's declared input fields and validation behavior.

## Installation Order Is Part of the Contract

`src/mcp/server-factory.ts` constructs each server in this order:

```ts
// Abbreviated from createMcpServer; options and remaining tool groups omitted.
const server = new McpServer(profile.server, {
  instructions: buildMcpInstructions(),
})
installToolRegistrationBoundary(server, boundaryOptions)
registerStartHereTool(server)
// Register the remaining enabled tool groups on this same server.
```

Install the boundary exactly once on the fresh instance, before registering tools. The implementation has no repeated-installation guard. A handler registered before installation keeps its direct SDK callback and bypasses Shellby's dispatch hooks.

The `McpServer` parameter type in capability registrars does not encode installation status. Callers such as `registerWebTool(server, webPageOpener)` rely on the factory's ordering.

## Schema and Result Ownership

`prepareToolRegistration()` in `src/mcp/tool-schema-presentation.ts` applies JSON Schema presentation rules, prunes redundant annotations, and selects output-schema visibility. Its returned metadata identifies the original callback convention and native-content classification.

The SDK owns input validation and validation against published output schemas. Compact ordinary tools omit their public output schemas. Structured output and native-content tools retain their configured output schemas. See [MCP Tool Surface](./mcp-tool-surface.md#result-boundary) and [Tool Naming and Schema Design](./tool-naming-and-schema-design.md).

`dispatchTool()` claims the pre-created audit entry using `context.mcpReq.id` and the tool name. It checks the current agent's initialization state before invoking the handler. A session with no `AgentIdentity.taskSlug` receives the startup-required tool error; `start_here` and requests without agent identity pass that gate.

After the callback returns, projection follows the configured compact/structured mode and native-content classification. Explicit `structuredContent.error_code` results preserve their metadata in compact output.

Notice collection has a fixed order: shell file-edit guidance, delegated-turn completion events, human steering instructions, then the optional review prompt. `collectToolEvents()` owns that order. Returned tool errors follow the normal notice path. Initialization rejections and thrown handlers return before notice collection. SDK input-validation failures bypass the wrapper.

The catch path converts exceptions into text tool errors and invokes observer-failure and audit hooks. Observation marks a returned tool error as a completed callback; audit independently classifies the result. Numeric nonzero `shell_run` exit codes remain failures for audit reporting.

## Ownership and Change Checks

HTTP authorization, session-context setup, transport lifetime, and auditing calls rejected before handler dispatch remain in `src/server/http-server.ts` and `src/server/audit/`. The boundary owns each registration's wrapper. Shell processes, document caches, and delegated conversations belong to shared capability services composed outside the server instance.

Preserve installation coverage, original handler arguments/context, SDK validation, native content, notice timing, and audit correlation when changing this boundary. Relevant tests include `test/mcp/tool-registration-boundary.test.ts`, `test/integrations/mcp-runtime.ts`, `test/integrations/session-initialization.ts`, `test/integrations/audit.ts`, `test/mcp/tool-schema-presentation.test.ts`, and `test/mcp/tool-output.test.ts`.

## Related

- [MCP Tool Surface](./mcp-tool-surface.md)
- [Tool Naming and Schema Design](./tool-naming-and-schema-design.md)
- [Audit Logging](./operations/audit-logging.md)
- [Build and Test](./operations/build-and-test.md)
