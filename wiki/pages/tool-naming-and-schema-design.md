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

### What ChatGPT Sees

The key model-facing behavior is that ChatGPT does not appear to consume the published MCP JSON Schema in its raw form. In the current observed ChatGPT tool context, the schema is projected into a TypeScript-like tool signature.

That projection preserves more than just the field types. Tool descriptions and parameter descriptions become comments, and schema metadata such as defaults, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, and similar constraints is also injected as comments beside the relevant TypeScript-like field. Required versus optional properties are represented directly in the type shape.

Conceptually, a published JSON Schema property such as a described bounded string becomes something like:

```ts
// Unique within this shell_id, such as scan-routes-1.
request_id: string, // minLength: 3, maxLength: 128
```

This means descriptions and any validation metadata that remains in the advertised schema are part of the effective model prompt, not merely server-side validation details. Schema design therefore directly affects both what calls are accepted and what guidance the model sees while choosing arguments.

For example, before Shellby's model-facing schema pruning was added, OpenAI presented `shell_run` to the model as:

```ts
// Run arbitrary zsh commands in a persistent shell. New shells start in "/Users/austinserb/Desktop/agent-workspace".
// - Use the apply_patch tool for file changes.
type shell_run = (_: {
// Unique persistent shell label such as api-audit. Reuse for command(s) that should share cwd or environment.
shell_id?: string, // default: "default", minLength: 3, maxLength: 64
// Unique within this shell_id, such as scan-routes-1.
request_id: string, // minLength: 3, maxLength: 128
// Omit to keep the cwd. Parallel `commands` inherit this cwd.
cwd?: string, // minLength: 1
// Exact zsh command or multiline script.
command?: string, // minLength: 1
// Independent zsh commands to run in parallel. Each command may override cwd.
// minItems: 1
commands?: Array<
{
// Exact zsh command or multiline script.
command: string, // minLength: 1
// Omit to inherit the shell_run cwd.
cwd?: string, // minLength: 1
}
>,
// Max wait time before returning. Running commands continue; use shell_poll.
wait_ms?: integer, // default: 3000, minimum: 0, maximum: 10000
// Usually omit. Increase only when you need more output in one response; continue retained output with shell_poll.
max_output_tokens?: integer, // default: 1024, minimum: 1, maximum: 16384
}) => any;
```

Schemas that rely on composition such as `oneOf` or `anyOf` are also more likely to project poorly when they cannot be represented as a clean TypeScript-like type. A likely failure mode is degradation to a catch-all shape such as:

```ts
{ [key: string]: any }
```

Treat this as an observed/probable projection limitation rather than a guaranteed mapping rule. Prefer directly representable object shapes, enums, arrays, and simple unions where practical, and verify the actual ChatGPT-visible schema when introducing more complex JSON Schema composition.

Shellby has one concrete instance supporting this warning. `shell_run` previously attached the following Zod metadata to express the exclusive relationship between `command` and `commands`:

```ts
.meta({
  oneOf: [{ required: ["command"] }, { required: ["commands"] }],
})
```

With that metadata present, ChatGPT exposed the tool arguments as the collapsed catch-all shape rather than the detailed object schema. Removing this `oneOf` metadata fixed the problem: ChatGPT again exposed the full TypeScript-like `shell_run` argument structure shown above.

This does not establish that Zod `.meta()` itself is unsafe. The relevant change was the JSON Schema composition injected through `.meta()`. Keep semantic validation such as the existing runtime/Zod refinement when useful, but avoid adding model-facing `oneOf`/`anyOf` composition solely to encode relationships that can instead be explained in parameter descriptions or enforced at validation time.

### Validation Schema vs Model Schema

Zod remains the source of truth for runtime validation. Before a schema is advertised through `tools/list`, the registration boundary creates a leaner model-facing JSON Schema. Removing a keyword from the advertised schema does not remove the corresponding Zod validation.

The boundary currently strips validation details that add little useful information to ChatGPT's TypeScript-like projection: `$schema`, `title`, `examples`, `format`, `multipleOf`, `maxLength`, `minItems`, `minLength` values of `0` or `1`, and numeric `minimum` values of `0` or `1`. It preserves larger `minLength` values and `pattern` because those constraints can materially affect how the model should construct a valid string. Defensive validation remains enforced by Zod even when details are omitted from the advertised schema.

Keep model-facing structure and constraints when they affect how the agent should plan or choose a value. In particular, preserve required/optional shape, types, enums, defaults, `maxItems`, numeric ceilings, and meaningful numeric ranges. A three-subagent `maxItems` limit changes planning; a 128-character ID ceiling usually does not.

After pruning, the registration boundary recursively puts the remaining JSON Schema keywords in one LLM-oriented canonical order: meaning first (`description`), then shape (`type`/references), defaults and choices, structure, and retained validation constraints. Tool parameter order inside `properties` is preserved (`src/server/mcp-server.ts`, `src/server/tool-registration-boundary.ts`, `test/tool-registration-boundary.test.ts`, `test/integrations/server.ts`).

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

Do not repeat information that remains visible in the advertised schema, such as enum values, required status, defaults, or retained ranges. If a validation-only rule is pruned from the advertised schema but the agent needs it to construct the value correctly, state that rule briefly in the parameter description.

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
