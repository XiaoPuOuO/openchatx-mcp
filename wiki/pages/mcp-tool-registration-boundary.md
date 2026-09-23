---
summary: "How the registerTool monkeypatch connects tool registration to Shellby's dispatch pipeline, including installation order, validation, notices, audit, and then_run."
paths:
  - src/mcp/server-factory.ts
  - src/mcp/tool-registration-boundary.ts
  - src/mcp/tool-schema-presentation.ts
  - src/mcp/tool-output.ts
  - src/mcp/then-run.ts
  - src/server/http-server.ts
  - src/server/audit/audit-request.ts
---

# MCP Tool Registration Boundary

## What the Monkeypatch Does

Shellby replaces `registerTool` on each newly created `McpServer` instance so registrations pass through Shellby's execution policy. This instance-level method replacement is the current monkeypatch. `installToolRegistrationBoundary()` captures the original SDK method, builds a local registry of tool handlers, and installs `boundaryRegisterTool` using `Reflect.set(server, "registerTool", boundaryRegisterTool)`. The SDK prototype remains unchanged (`src/mcp/tool-registration-boundary.ts`).

A tool module calls `server.registerTool(name, config, handler)` in the familiar SDK form. That call now prepares the public schema, records the original handler, and gives the SDK a wrapper that invokes `dispatchTool()`. The captured SDK method is called through `Reflect.apply` with the original server as its receiver. The resulting pipeline centralizes initialization gating, nested dispatch, result projection, notices, and audit/observer hooks.

## Mental Model

```text
REGISTRATION: once for each fresh MCP server

server-factory.ts creates McpServer
    |
    v
installToolRegistrationBoundary(server, options)
    | saves the SDK method; replaces this instance's registerTool
    v
Tool module calls server.registerTool(name, config, handler)
    |
    v
Shellby's boundaryRegisterTool
    |-- prepare schema and annotations
    |-- remember the original handler and execution metadata
    `-- call the original SDK registerTool with a wrapped handler

EXECUTION: each call reaching the wrapped handler

MCP SDK calls the wrapper
    |
    v
dispatchTool(name, input, context)
    |-- associate audit entry; validate nested input
    |-- extract then_run; enforce start_here gate
    |-- start observation
    |-- invoke the original tool handler
    |-- validate nested output; finish observation
    |-- project result; append notices; finish this call's audit
    `-- eligible then_run?
            | yes: dispatchTool(nextName, nextInput, sameContext, true)
            |      then merge its result with prior content
            v
       Return the MCP result to the SDK
```

This shows the normal return path. Validation, initialization, and exception exits are described below. Registration changes which callback the SDK invokes; the execution wrapper supplies the shared behavior (`src/mcp/tool-registration-boundary.ts`: `boundaryRegisterTool`, `dispatchTool`, `continueThenRun`).

## Installation Order Is Part of the Contract

`src/mcp/server-factory.ts` currently constructs each server in this order:

```ts
// Abbreviated from createMcpServer; options and remaining tool groups omitted.
const server = new McpServer(profile.server, {
  instructions: buildMcpInstructions(),
})
installToolRegistrationBoundary(server, boundaryOptions)
registerStartHereTool(server)
// Register the remaining enabled tool groups on this same server.
```

Install the boundary exactly once on the fresh instance, before registering any tools. The implementation has no repeated-installation guard. A handler registered before installation keeps its direct SDK callback and stays outside the boundary's internal tool registry. As a consequence, it bypasses Shellby's dispatch hooks and cannot be found as a `then_run` target.

The `McpServer` parameter type in capability registrars does not encode installation status. Callers of functions such as `registerWebTool(server, webPageOpener)` therefore rely on the factory's ordering. An explicit registrar has been discussed as an alternative; the implementation documented here remains the instance-method override.

## Registration-Time Responsibilities

`prepareToolRegistration()` in `src/mcp/tool-schema-presentation.ts` adds optional `then_run` input to ordinary tools, applies JSON Schema presentation rules, prunes redundant annotations, and selects output-schema visibility. `start_here` receives its original input schema. Supplied ordinary input schemas must be Zod objects; a tool without an input schema receives an object containing `then_run` (`src/mcp/then-run.ts`: `withThenRunSchema`).

The boundary records whether the original handler expects arguments, its retained Zod schemas, and its native-content classification. This preserves the handler's original calling convention. Native-content exceptions and schema-projection details are maintained in [MCP Tool Surface](./mcp-tool-surface.md#result-boundary) and [Tool Naming and Schema Design](./tool-naming-and-schema-design.md).

An important validation limit follows from registration order: compact ordinary tools have `config.outputSchema` cleared before execution metadata is captured. Those tools therefore have no retained output validator in the boundary. Preserve this distinction when changing schema presentation or moving validation.

## Execution, Validation, and Result Ownership

For a top-level call, `dispatchTool()` claims the pre-created audit entry using `context.mcpReq.id` and the tool name. For a nested call, it creates a separate audit entry marked `via: then_run`. It then obtains the original callback arguments by removing `then_run` and checks the current agent's initialization state. A session with no `AgentIdentity.taskSlug` receives the startup-required tool error; `start_here` and requests without agent identity pass that gate (`src/mcp/tool-registration-boundary.ts`, `src/server/audit/audit-request.ts`).

Top-level input validation belongs to the SDK. Nested calls bypass SDK dispatch, so the boundary runs their retained input schema through `safeParseAsync()`. For output, top-level retained schemas are supplied to the SDK; nested retained schemas are checked by `validateToolOutput()`. Error results with `isError: true` skip that nested output check.

After the callback returns, the boundary finishes observation, projects the result, collects notices, and finishes that call's audit before evaluating the next `then_run`. Top-level projection follows the configured compact/structured mode and native-content classification. Nested results pass through compact projection even when the outer call uses structured mode. Existing native content blocks remain in the result; explicit structured error-code results are preserved by `compactToolResult()` (`src/mcp/tool-output.ts`).

Notice collection has a fixed order: shell file-edit guidance, delegated-turn completion events, human steering instructions, then the optional review prompt. `collectToolEvents()` owns that order. A returned `isError: true` still follows this normal return path. An initialization rejection, nested input-validation failure, or thrown handler returns before notice collection. The catch path converts an exception into a text tool error and invokes the observer-failure and audit hooks. Observation currently marks a returned tool error as a completed callback; audit and chaining inspect the result separately (`src/mcp/tool-registration-boundary.ts`).

## How then_run Uses the Same Pipeline

`continueThenRun()` evaluates chaining after the preceding callback has returned. Chaining stops on `isError: true`, or a numeric nonzero `shell_run` exit code. A `status: "running"` result alone does not stop the chain. Consequently, chaining follows tool-call completion and can proceed while a shell command or delegated turn continues independently (`src/mcp/then-run.ts`: `toolResultFailed`).

`parseThenRun()` requires exactly one entry, object arguments, and a target present in this server's registry. It rejects `start_here` as a nested target. A valid next call invokes `dispatchTool()` directly with the same context and `nested = true`; each nested call can supply another `then_run`. This adds no separate HTTP request or fresh SDK server.

`mergeThenRunResult()` combines content in execution order, coalesces adjacent text blocks, propagates nested `isError`, and carries an explicit nested `structuredContent.error_code` when present. It preserves the outer structured result apart from that error metadata; nested successful structured results are represented through their projected content. A malformed next call adds a `then_run_error` tool result after the prior output. Earlier side effects remain applied.

## Ownership and Change Checks

HTTP authorization, session-context setup, transport lifetime, and auditing calls rejected before handler dispatch remain in `src/server/http-server.ts` and `src/server/audit/`. The boundary owns the local registration map and dispatch wrapper for one server instance. Shell processes, document caches, and delegated conversations belong to the shared capability services composed outside that instance. See [Architecture Map](./architecture-map.md) and [HTTP Transport](./http-transport.md).

When changing this connection, preserve installation coverage, original handler arguments/context, validation behavior, native content, notice timing, and `then_run` result ordering. Relevant evidence lives in `test/integrations/mcp-runtime.ts`, `test/integrations/session-initialization.ts`, `test/integrations/audit.ts`, `test/mcp/tool-schema-presentation.test.ts`, and `test/mcp/tool-output.test.ts`. These cover observable behavior; the installation-order requirement is also visible directly in `src/mcp/server-factory.ts`. [Build and Test](./operations/build-and-test.md) describes validation commands.

## Related

- [MCP Tool Surface](./mcp-tool-surface.md)
- [Tool Naming and Schema Design](./tool-naming-and-schema-design.md)
- [Audit Logging](./operations/audit-logging.md)
