---
summary: "OpenChatX platform primitives: unified capabilities, jobs, projects, providers, routing, teams, workflows, store, nodes, health, and dashboard ownership."
paths:
  - src/capabilities/
  - src/jobs/
  - src/projects/
  - src/providers/
  - src/subagents/
  - src/teams/
  - src/workflows/
  - src/store/
  - src/nodes/
  - src/platform/
---

# Platform Capabilities

OpenChatX treats ChatGPT as the primary planner and the local runtime as a capability platform. The model-facing surface stays small while MCP servers, custom Toolbox tools, model profiles, Providers, composed workflows, and remote OpenChatX nodes remain discoverable on demand.

## Unified Capability Catalog

\`src/capabilities/catalog.ts\` is the model-facing catalog owner. It normalizes external MCP servers, custom Toolboxes, subagent profiles, and Providers into \`CapabilityDescriptor\` records. \`start_here\` renders lightweight summaries and \`capability_list\` returns exact invocation metadata. Large tool schemas remain behind \`tool_search\` / \`tool_call\`.

\`src/capabilities/health.ts\` owns operational health for the local runtime, Secure MCP Tunnel, external MCPs, Toolboxes, and Providers. The same snapshot is exposed through \`capability_health\` and the Dashboard.

## Durable Work and Projects

\`src/jobs/job-manager.ts\` persists long-running background commands under \`<state_dir>/jobs\`. Jobs outlive individual MCP requests and expose status plus retained logs.

\`src/projects/project-registry.ts\` persists named existing filesystem roots and their read/write/shell permission scope. Registering a project never moves or copies the project. Project-scoped durable jobs resolve the project with \`shell\` permission before execution.

## Providers, Routing, and Teams

\`src/providers/provider-hub.ts\` owns Provider presets and connectivity probes for hosted and local OpenAI-compatible runtimes. Presets include hosted OpenAI/OpenRouter and local Ollama/LM Studio/vLLM endpoints.

\`src/subagents/router.ts\` scores enabled model profiles against task text, tags, local-only policy, context requirements, and cost tier. It can return the selected profile or route and execute the task.

\`src/teams/team-service.ts\` persists named Agent Teams made from curated profiles. Team execution fans one task out in parallel and returns separate member work products. ChatGPT remains responsible for synthesis and final decisions.

## Capability Composer

\`src/workflows/workflow-service.ts\` persists sequential workflows. Steps can invoke lazy Toolbox/MCP tools, subagent profiles, Agent Teams, or Durable Jobs. Templates support \`{{input}}\` plus prior step output through \`{{steps.<id>}}\`. Workflow execution stops on the first failed step and preserves the per-step result/error record.

## Capability Store

\`src/store/store-service.ts\` owns the local Store catalog and installation state. Store bundles are copied into the normal Toolbox root, then the Toolbox registry hot reloads them. Ownership state under \`<state_dir>\` prevents the Store from deleting unrelated Toolbox directories.

The checked-in \`store/catalog.json\` is intentionally small; it is the seed catalog and can evolve into a larger distribution mechanism without changing the Toolbox runtime contract.

## Multi-machine Nodes

\`src/nodes/node-registry.ts\` persists remote OpenChatX MCP endpoints, redacts node tokens from list results, probes \`/healthz\`, discovers remote MCP tools lazily, and forwards tool calls on demand. Nodes are not merged into the main MCP schema surface.

## Platform Home

\`src/platform/overview.ts\` composes counts, registered Projects, active Durable Jobs, and attention items for the Dashboard. \`ui/src/features/dashboard/PlatformHomePanel.tsx\` presents this as the default platform view while the existing agent observer continues to show live ChatGPT sessions.

## Ownership Rules

- ChatGPT stays the planner and integrator.
- OpenChatX owns capability discovery, persistence, lifecycle, routing, and execution boundaries.
- External MCP schemas and remote node schemas stay lazy.
- Providers expose only curated profiles, never an entire provider catalog automatically.
- Project registration never implies a filesystem sandbox; it is explicit context and permission metadata.
- Store uninstall only removes paths recorded as Store-owned.
- Teams return member results separately instead of introducing a second autonomous planner.
