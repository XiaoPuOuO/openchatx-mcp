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

\`src/projects/project-registry.ts\` persists named existing filesystem roots and their read/write/shell permission scope. Registering a project never moves or copies the project, duplicate normalized roots are rejected, and nested roots resolve to the deepest registered Project.

\`src/projects/project-scope.ts\` binds an optional active Project to the process-wide ChatGPT session identity. \`project_manage action=use\` changes that session context. Relative built-in file/search/bash/terminal/image/apply-patch/job paths resolve from the active Project; explicit \`project_id\` resolves from that root and rejects lexical path escape. Absolute paths that fall under any registered Project automatically inherit that Project's permission policy even when no Project is active. Durable Jobs persist their \`projectId\`, Workflow job steps use the same scope, Agent snapshots expose their Project, and the Dashboard groups active agents/jobs by Project.

Project permissions are an OpenChatX policy layer for built-in tools, not an operating-system sandbox. A shell or terminal process can perform actions beyond its initial cwd, and custom Toolboxes or external MCP servers may implement their own access model.

## Providers, Routing, and Teams

\`src/providers/provider-hub.ts\` owns Provider presets and connectivity probes for hosted and local OpenAI-compatible runtimes. Presets include hosted OpenAI/OpenRouter and local Ollama/LM Studio/vLLM endpoints.

\`src/subagents/router.ts\` scores enabled model profiles against task text, tags, local-only policy, context requirements, and cost tier. It can return the selected profile or route and execute the task.

\`src/teams/team-service.ts\` persists named Agent Teams made from curated profiles. Team execution fans one task out in parallel and returns separate member work products. ChatGPT remains responsible for synthesis and final decisions.

## Capability Composer

\`src/workflows/workflow-service.ts\` persists sequential workflows. Steps can invoke lazy Toolbox/MCP tools, subagent profiles, Agent Teams, or Durable Jobs. Templates support \`{{input}}\` plus prior step output through \`{{steps.<id>}}\`. Workflow execution stops on the first failed step and preserves the per-step result/error record.

## Capability Store

\`src/store/store-service.ts\` owns built-in Store bundles, Store installation state, exact-revision installation, source inspection, static review, and publish validation. Built-in bundles are copied into the normal Toolbox root, then the Toolbox registry hot reloads them. Ownership state under \`<state_dir>\` prevents the Store from deleting unrelated Toolbox directories.

\`src/store/github-community-store.ts\` provides serverless Community discovery. It searches public GitHub repositories tagged \`openchatx-capability\`, resolves the selected repository to an immutable commit SHA, reads \`capability.json\`, exposes the source tree and blobs for inspection, and downloads only the selected Toolbox subtree. Symlinks, git submodules, unsafe relative paths, oversized trees, oversized files, and oversized installs are rejected at the Store boundary.

Community capabilities are not reviewed or endorsed by OpenChatX. \`store_browse\` with \`action=review\` performs bounded static analysis for shell/process execution, network access, filesystem access, credential/environment access, dynamic code execution, and package lifecycle scripts. It also compares observed behavior against declared \`capability.json\` permissions. The result is evidence, not a safety verdict; ChatGPT can inspect cited files through \`store_browse\` with \`action=source_read\`.

Community publishing requires no OpenChatX server. Authors publish a public GitHub repository, keep \`capability.json\` at the repository root, and add the \`openchatx-capability\` topic. \`store_manage\` with \`action=publish_check\` validates a local directory before publication. \`GITHUB_TOKEN\` is optional and is used only for authenticated GitHub API rate limits.

The checked-in \`store/catalog.json\` remains the built-in seed catalog and does not act as a moderation queue for Community capabilities.

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
