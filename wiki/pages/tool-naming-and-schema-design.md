---
summary: "Model-facing conventions for tool names, routing descriptions, schemas, parameter descriptions, and compact outputs."
paths:
  - src/server/tool-registration-boundary.ts
  - src/server/tool-output.ts
  - src/tools/
---

# Tool Naming and Schema Design

## What This Is

Tool metadata is a compact routing interface for ChatGPT. Optimize for correct selection and invocation, not for explaining implementation.

## Core Model

> **Name identifies. Description routes. Schema constrains. Parameter descriptions disambiguate. Output schema guides the next move. Wiki explains implementation.**

Avoid repeating information ChatGPT can already infer from the tool name or schema.

## Tool Names

Prefer:

```text
<domain>_<specific action>
```

Examples: `skill_list`, `skill_load`, `shell_run`, `shell_poll`, `computer_click`.

Use concrete conventional verbs such as `list`, `load`, `read`, `fetch`, `run`, `poll`, `create`, `delete`, `reset`, and `close`. Avoid vague verbs such as `use`, `manage`, `handle`, or `process` when a precise action exists.

Sibling tools should form predictable families. The name alone should give ChatGPT a strong initial guess about the operation.

## Tool Descriptions

Default shape:

```text
[Specific action/purpose]. [When to select it, if not obvious]. [Critical routing boundary, if needed].
```

Keep descriptions short, usually one-two sentences. Include only information that helps ChatGPT decide whether this is the correct tool.

Do not restate schema-visible facts such as enums, required fields, numeric ranges, defaults, or formats unless that constraint materially changes tool selection.

Do not include implementation details such as filesystem layout, caching strategy, symlink behavior, dynamic discovery, or why the schema stays stable. Those belong in the wiki.

## Negative Boundaries

Do not add `Do not use...` instructions by default. Add a negative boundary when there is evidence of incorrect tool use or a clear recurring collision between adjacent tools.

Example: if agents repeatedly edit files through `shell_run` instead of `apply_patch`, a short routing boundary may be justified. Avoid speculative negative instructions that add noise without fixing a real selection problem.

## Input Schemas

Use the schema for mechanically inferable constraints:

- required vs optional
- types
- enums
- defaults
- min/max values
- string formats
- structural relationships that can be encoded directly

Prefer schemas that make invalid calls difficult rather than prose that asks the model to remember validation rules.

Before tool schemas are advertised, the registration boundary recursively puts JSON Schema keywords in one LLM-oriented canonical order: meaning first (`description`), then shape (`type`/references), defaults and choices, structure, and validation constraints. Tool parameter order inside `properties` is preserved. The transform changes only object-key insertion order; Zod validation, defaults, constraints, and schema values are unchanged (`src/server/mcp-server.ts`, `src/server/tool-registration-boundary.ts`, `test/tool-registration-boundary.test.ts`, `test/mcp-integration.test.ts`).

## Parameter Descriptions

Use parameter descriptions only for meaning that is not obvious from the field name, type, and schema.

Good uses include:

- semantic meaning
- relationship to another parameter
- continuation or identity rules
- behavior that affects how the value should be chosen

Example:

```text
name: Skill name returned by `skill_list`.
```

Do not repeat enum values, ranges, required status, defaults, or formats already encoded in the schema.

## Output Contracts

Design the smallest stable result shape that lets the client decide what to do next. With the default `mcp.tool_output = "compact"`, the registration boundary strips ordinary public output schemas and renders ordinary typed results as compact Markdown. With `mcp.tool_output = "structured"`, it preserves the ordinary output schemas and native structured results. Computer Use and `image_view` keep their native MCP content blocks in either mode (`src/server/tool-registration-boundary.ts`).

Keep tool descriptions focused on routing. Result-shape details belong in native MCP schemas/content where retained, in compact output shaping, or in the wiki when callers need durable semantics.

## Review Checklist

Before publishing or revising a tool, ask:

1. **Name:** Would ChatGPT have a good guess what this does from the name alone?
2. **Description:** Does it explain when to choose this tool rather than how it is implemented?
3. **Schema:** Are mechanical constraints encoded instead of repeated in prose?
4. **Parameters:** Do descriptions add semantic information rather than restating the schema?
5. **Output:** Is the result compact and sufficient for the next decision?
6. **Noise:** Can any sentence be removed without reducing correct routing or invocation?

When tool-use mistakes are observed, fix the smallest layer that caused the ambiguity: rename an unclear tool, sharpen its routing description, improve a parameter description, tighten the schema, or add a negative boundary only when needed.

## Related

- [MCP Tool Surface](./mcp-tool-surface.md)
- [Architecture Map](./architecture-map.md)
- [Build and Test](./operations/build-and-test.md)
