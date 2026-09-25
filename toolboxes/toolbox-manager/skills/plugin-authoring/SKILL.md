---
name: plugin-authoring
description: Create or revise openchatx-mcp Toolbox plugins and TypeScript tools from a user's natural-language request.
---

# Plugin authoring

Use this skill when the user asks for a new plugin, toolbox, custom tool, or reusable local capability.

## Model

- A **Toolbox** is the plugin/folder boundary: `toolboxes/<toolbox-id>/`.
- One Toolbox can contain many TypeScript tools under `tools/` and many skills under `skills/`.
- Custom tools are lazy-loaded and discovered through `tool_search`; they do not expand the main MCP tool schema budget.
- Tool names must match their source filename without `.ts`.

## Workflow

1. Use `toolbox_list` to inspect existing plugins and avoid duplicates.
2. If needed, create the plugin with `toolbox_manage` using `kind="toolbox"`, `action="create"`. New custom toolboxes start disabled so incomplete code is not callable.
3. Create each TypeScript tool with `toolbox_manage` using `kind="tool"`, `action="create"`. The generated file is a valid SDK template and the result includes its path.
4. Edit the generated `.ts` file with `file_edit` for precise changes or `apply_patch` for structural changes. Do not write source through `bash`.
5. Implement tools with the public SDK:

```ts
import { defineTool, z } from "openchatx-mcp/toolbox"

export default defineTool({
  name: "example",
  description: "Describe exactly when the agent should use this tool.",
  inputSchema: z.object({
    value: z.string(),
  }),
  async execute({ value }, context) {
    return {
      content: [{ type: "text", text: value }],
    }
  },
})
```

6. Keep tool inputs small, explicit, and typed. Return normal MCP `content`; use `structuredContent` when structured output materially helps callers.
7. Never embed secrets in committed tool source or `toolbox.json`. Read credentials from an appropriate local secret/config source.
8. Use `toolbox_manage` with `action="reload"`, then `toolbox_list` and verify there is no load error.
9. Enable the tool and then the toolbox only after the implementation loads successfully.
10. Use `tool_search` to confirm discovery and `tool_call` to run a realistic test.

## Lifecycle and advanced capabilities

`defineTool` supports optional MCP metadata plus `required`, `onLoad`, and `onUnload`. Use lifecycle hooks only when the tool genuinely owns a resource that must be initialized or released.

Prefer one coherent Toolbox for closely related capabilities instead of creating one plugin per tiny function. Split plugins when dependencies, permissions, or domains are meaningfully independent.

## Destructive changes

Deleting a custom Toolbox removes its folder recursively. Deleting a Tool removes its `.ts` source. Confirm the user's intent before deleting meaningful user-authored code unless deletion was explicitly requested.
