import assert from "node:assert/strict"
import test from "node:test"
import {
  appendToolEvents,
  compactToolResult,
  formatOutputBlock,
  renderStructuredContent,
} from "../../src/mcp/tool-output.js"
import { countTokens } from "../../src/tokenizer.js"

test("renders compact scalar metadata and multiline strings without losing values", () => {
  const structured = {
    status: "completed",
    exit_code: 0,
    cwd: "/workspace",
    output: "line one\nline two",
  }
  const rendered = renderStructuredContent(structured)

  assert.equal(
    rendered,
    "status=completed exit_code=0 cwd=/workspace\n\noutput:\n\nline one\nline two"
  )
  assert.match(rendered, /completed/u)
  assert.match(rendered, /\/workspace/u)
  assert.match(rendered, /line one\nline two/u)
  assert.ok(countTokens(rendered) < countTokens(JSON.stringify(structured)))
})

test("does not treat changed or failed as block strings by default", () => {
  assert.equal(renderStructuredContent({ changed: "one", failed: "two" }), "changed=one failed=two")
})

test("formats top-level output blocks with a shared boundary", () => {
  assert.equal(
    formatOutputBlock(["turn_id=test_turn_1", "status=completed"], "## Result\n\nDone."),
    "---- turn_id=test_turn_1 status=completed ----\n\n## Result\n\nDone."
  )
})

test("formats global tool events as notices", () => {
  const result = appendToolEvents({ content: [{ type: "text", text: "Done." }] }, [
    "Use the `apply_patch` MCP tool over `bash` for file changes.",
    "agent_finished agent_id=reviewer turn_id=reviewer_turn_1",
  ]) as { content: Array<{ type: string; text: string }> }

  assert.equal(
    result.content[0]?.text,
    "Done.\n\n**Notice:** Use the `apply_patch` MCP tool over `bash` for file changes.\n**Notice:** agent_finished agent_id=reviewer turn_id=reviewer_turn_1"
  )
})

test("quotes strings that would otherwise be indistinguishable from non-string scalars", () => {
  assert.equal(
    renderStructuredContent({
      string_false: "false",
      boolean_false: false,
      string_null: "null",
      null_value: null,
      string_number: "123",
      number_value: 123,
    }),
    'string_false="false" boolean_false=false string_null="null" null_value=null string_number="123" number_value=123'
  )
})

test("renders arrays of simple objects as compact rows and nested objects recursively", () => {
  assert.equal(
    renderStructuredContent({
      turns: [
        { turn_id: "a", status: "running" },
        { turn_id: "b", status: "completed" },
      ],
      metadata: { count: 2, source: "chatgpt" },
    }),
    "turns:\n\n- turn_id=a status=running\n- turn_id=b status=completed\n\nmetadata:\n  count=2 source=chatgpt"
  )
})

test("renders long record fields as nested Markdown instead of JSON", () => {
  const response =
    "## Findings\n\nUse the shared registration boundary.\n\n```ts\ninstallToolRegistrationBoundary(server)\n```"
  const rendered = renderStructuredContent({
    turns: [
      { turn_id: "reviewer_turn_1", status: "completed", response },
      {
        turn_id: "tester_turn_1",
        status: "completed",
        response: "## Tests\n\nAdd a regression test for multiline output.",
      },
    ],
  })

  assert.equal(
    rendered,
    "turns:\n\n- turn_id=reviewer_turn_1 status=completed\n\n  response:\n    ## Findings\n\n    Use the shared registration boundary.\n\n    ```ts\n    installToolRegistrationBoundary(server)\n    ```\n\n- turn_id=tester_turn_1 status=completed\n\n  response:\n    ## Tests\n\n    Add a regression test for multiline output."
  )
  assert.doesNotMatch(rendered, /\{"turn_id"/u)
  assert.doesNotMatch(rendered, /\\n/u)
})

test("falls back to minified JSON for unusual nested arrays", () => {
  const nested = { items: [[{ value: 1 }], [{ value: 2 }]] }
  assert.equal(renderStructuredContent(nested), 'items:\n\n[[{"value":1}],[{"value":2}]]')
})

test("compact result preserves existing content and removes structuredContent", () => {
  const compact = compactToolResult("bash", {
    structuredContent: { status: "completed", output: "hello" },
    content: [{ type: "text", text: "Command finished." }],
  }) as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }

  assert.equal(compact.structuredContent, undefined)
  assert.deepEqual(compact.content, [
    { type: "text", text: "Command finished.\n\nstatus=completed output=hello" },
  ])
})

test("compact fetch_url image results preserve native image content while rendering metadata", () => {
  const result = compactToolResult("fetch_url", {
    structuredContent: {
      url: "https://example.com/pixel.png",
      title: "pixel.png",
      status: 200,
      content_type: "image/png",
      content: "",
    },
    content: [{ type: "image", data: "abc", mimeType: "image/jpeg" }],
  }) as {
    structuredContent?: unknown
    content?: Array<{ type: string; text?: string; data?: string }>
  }

  assert.equal(result.structuredContent, undefined)
  assert.equal(
    result.content?.some((item) => item.type === "image" && item.data === "abc"),
    true
  )
  assert.match(
    result.content?.find((item) => item.type === "text")?.text ?? "",
    /url=https:\/\/example.com\/pixel.png.*status=200.*content_type=image\/png/u
  )
})

const longSkillDescription =
  "Create or revise reusable skills for this ChatGPT local-shell MCP workspace, including reusable agent workflows and adaptations of existing skills without bloating the tool schema."

const toolFamilyCases: Array<{ tool: string; structuredContent: unknown; expected: string }> = [
  {
    tool: "bash",
    structuredContent: {
      cwd: "/workspace",
      exit_code: 1,
      output: "line one\nline two",
    },
    expected: "cwd=/workspace exit_code=1\n\noutput:\n\nline one\nline two",
  },
  {
    tool: "apply_patch",
    structuredContent: {
      status: "failed",
      exit_code: 1,
      output: "Invalid Context 0:\nexpected line",
      output_dropped: true,
    },
    expected:
      "status=failed exit_code=1 output_dropped=true\n\noutput:\n\nInvalid Context 0:\nexpected line",
  },
  {
    tool: "fetch_url",
    structuredContent: {
      url: "https://example.com/docs",
      title: "Example Page",
      status: 200,
      content_type: "text/html; charset=utf-8",
      content: "# Heading\n\nPage body.",
      next_cursor: "cursor-2",
    },
    expected:
      'url=https://example.com/docs title="Example Page" status=200 content_type="text/html; charset=utf-8" next_cursor=cursor-2\n\ncontent:\n# Heading\n\nPage body.',
  },
  {
    tool: "skill_search",
    structuredContent: { skills: [{ name: "create-skill", description: longSkillDescription }] },
    expected: `skills:\n\n- name=create-skill\n\n  description:\n    ${longSkillDescription}`,
  },
  {
    tool: "skill_load",
    structuredContent: {
      name: "create-skill",
      path: "/workspace/skills/create-skill/SKILL.md",
      markdown: "# Skill\n\nDo the work.",
    },
    expected:
      "name=create-skill path=/workspace/skills/create-skill/SKILL.md\n\nmarkdown:\n# Skill\n\nDo the work.",
  },
]

for (const { tool, structuredContent, expected } of toolFamilyCases) {
  test(`renders the ${tool} compact result shape`, () => {
    assert.equal(compactText(tool, structuredContent), expected)
  })
}

function compactText(tool: string, structuredContent: unknown): string {
  const compact = compactToolResult(tool, { structuredContent }) as {
    content?: Array<{ type: string; text?: string }>
  }
  return compact.content?.find((item) => item.type === "text")?.text ?? ""
}
