---
summary: "Clone branching, shared delegated-ID ownership, persistence, and reuse through the ChatGPT agent runtime."
paths:
  - src/tools/subagent/clone-tools.ts
  - src/tools/subagent/chatgpt-subagent.ts
  - src/tools/subagent/chatgpt-subagent-browser.ts
  - src/tools/subagent/subagent-store.ts
  - src/config.ts
---

# Clones

Clone tools share the browser service, caller scope, and `chatgpt.max_delegated_agents` admission limit with subagents. `clone_id` and `agent_id` occupy the same per-caller namespace. Keep admission checks before browser work so persisted mappings and in-flight creations prevent duplicate allocation.

`clone_self` navigates a managed source page to the supplied ChatGPT conversation, branches its latest turn through ChatGPT's UI, closes the temporary source page when separate, then submits the caller's first prompt in the branch. A previously used clone ID is rejected. Failed creation releases the operation and closes pages created by that attempt.

`clone_run` reuses a live clone or restores a persisted mapping whose kind is `clone`; an ordinary subagent mapping cannot be treated as a clone. Clones always retain memory and branched context. They do not receive the extra first-turn instructions injected for new ordinary subagents.

`clone_result` uses the same local poll implementation as `subagent_result`. Completion events, one-shot recovery, uncertain upstream state, and process-local turn results follow [Subagent Completion](../subagents/subagent-completion.md). The public batch result limit remains independent of the configured delegated-ID cap.

## Related

- [Browser ChatGPT Subagents](../subagents/browser-chatgpt-subagents.md)
- [Subagent caller contract](./subagent.md)
- [Session Tracking](../subagents/subagent-tracking.md)
