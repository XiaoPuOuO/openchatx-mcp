---
summary: "Candidate real-work coding benchmarks for comparing ChatGPT Web plus Shellby MCP with Codex under equivalent task conditions."
---

# Possible Evals

## What This Is

The target benchmark is ChatGPT Web + Shellby MCP versus Codex on the same real software-engineering work. Prefer tasks derived from work that actually happened, a single user turn, a recoverable pre-task repository state, one autonomous attempt, and an external grader that scores the final repository rather than the agent's prose.

Benchmark details below preserve an earlier research snapshot, not a refreshed upstream inventory. Recheck official sources before selecting or running an evaluation.

## SWE-Lancer

SWE-Lancer is derived from real paid Expensify engineering jobs posted on Upwork. The original benchmark contains 1,488 tasks worth $1 million in actual payouts; 764 are individual-contributor implementation tasks and 724 are management proposal-selection tasks. The current public repository says it retains 198 tasks after adjusting and verifying them for offline execution, down from the original 237-problem public set. Issues are presented as originally written, and IC tasks pair the pre-fix codebase with the task description and objective. Professional engineers wrote end-to-end graders and each IC grader was independently reviewed three times.

This is the stronger fit for a first Shellby MCP-vs-Codex benchmark because IC SWE is natively one-shot. The agent may take many shell/editor/test actions, but the user-facing task does not depend on later clarification turns. The benchmark also uses pass@1 and removes future commits and repository remotes from the execution environment.

Main limitations:

- All original tasks come from one large TypeScript/JavaScript product, Expensify, so repository and language diversity are limited.
- Official task images are heavy; the public README says task-specific images are roughly 14 GB and take 10-20 minutes to build.
- Valid current runs are designed for internet-disabled Linux. The repository permits macOS runs only with internet left enabled and explicitly does not consider those canonical because some tasks behave abnormally.
- Because Shellby MCP exposes browser/web capabilities that Codex may not match exactly, decide before the run whether this is a full-system comparison or a shell/files-only comparison. SWE-Lancer itself has published no-user-tool baselines, so a no-browser variant is defensible.

### Bare-macOS investigation

The public task files make the pre-task source state easy to reconstruct: each IC task carries a commit ID plus either a bug-reintroduction patch or revert command. The grader is the portability blocker.

All 198 current IC tasks have a Playwright `test.py` and a recorded `flow.mitm`; there is no simpler unit-test-only subset. The shared grader compiles and starts the historical Expensify web app, starts mitmproxy with the task's recorded network flow, rewrites Playwright to use that proxy, waits for the local app, and then runs the task-specific browser test. The common runtime also starts Pusher-Fake and nginx, edits `/etc/hosts`, installs local certificates, and uses Linux-specific `/app`, `/root`, X11, package-management, and certificate paths (`runtime_scripts/setup_expensify.yml`, `runtime_scripts/setup_mitmproxy.yml`, `runtime_scripts/run_tests.yml`, `runtime_scripts/run.sh`, `runtime_scripts/rewrite_test.py`).

A macOS port is technically possible because the core components have macOS equivalents, but it would require maintaining a custom grader runtime and validating its behavior against the official environment. That defeats the desired simple workflow of copying a task into two identical local workspaces and running the existing verifier. Do not port SWE-Lancer to bare macOS unless preserving SWE-Lancer specifically becomes more important than benchmark simplicity.

Sources: [paper](https://arxiv.org/abs/2502.12115), [OpenAI overview](https://openai.com/index/swe-lancer/), [current eval repository](https://github.com/openai/frontier-evals/tree/main/project/swelancer).

## SWE-Together

SWE-Together has stronger trajectory provenance. It starts from 11,260 recorded real user-agent coding sessions and retains only 109 executable repository-level tasks, a 0.97% conversion rate. Candidates must contain genuine multi-turn user interaction, concrete agent actions or edits, enough repository context to recover the working state, and work primarily implemented by the coding agent. The final suite spans DataClaw, Pi-staging, Hyperswitch production traces, and SWE-chat sessions.

The problem for this benchmark is protocol fit: SWE-Together is intentionally not one-shot. Each task begins with the real first user message, then a state-conditional user simulator progressively releases the original clarifications, corrections, reviews, and additional requirements. The canonical score includes final correctness plus how much corrective steering the agent required. Its primary correctness signal is an agentic rubric judge rather than only deterministic tests.

Flattening the later intents into the first prompt would create a custom derivative benchmark, not a canonical SWE-Together run. Running only the first message would also omit requirements that the benchmark deliberately expects to arrive later. Some frozen rubrics additionally contain process requirements such as answering a follow-up or diagnosing before editing, so single-turn adaptation can distort grading.

SWE-Together remains valuable for a later benchmark if Shellby MCP-versus-Codex multi-turn replay becomes practical. The repository already ships pinned task environments, tests, reference patches, user-simulator prompts, and support for local Docker or cloud sandboxes.

Sources: [paper](https://arxiv.org/abs/2606.29957), [repository](https://github.com/Togetherbench/SWE-Together), [dataset](https://huggingface.co/datasets/yfwu/SWE-Together).

## Fit

| Criterion                                                      | SWE-Lancer IC                                   | SWE-Together                                                |
| -------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| Originates from real engineering work                          | Excellent: actual paid jobs and completed fixes | Excellent: recorded real user-agent coding sessions         |
| Native single-user-turn task                                   | **Yes**                                         | **No**                                                      |
| Recoverable pre-task repository                                | Yes                                             | Yes                                                         |
| Final code is externally graded                                | Yes, hidden end-to-end tests                    | Yes, primarily frozen agentic rubric + executable evidence  |
| Easy to run one task independently                             | Yes                                             | Yes, but canonical run requires user simulator              |
| Fits ChatGPT Web + Shellby MCP without a multi-turn adapter | **Yes**                                         | **No**                                                      |
| Current Mac friction                                           | High for canonical runs                         | Docker-supported, but multi-turn integration is the blocker |
| Repository diversity                                           | Low: Expensify only                             | Higher: multiple upstream datasets/repos                    |

## Recommendation

For interaction protocol and provenance, **SWE-Lancer IC** remains the better fit: one real task, one initial codebase, one autonomous attempt, final repository grading. For a strict **bare-macOS, no-container** benchmark, however, SWE-Lancer is not a good operational fit because every current IC grader depends on its shared browser/replay test lab.

Keep **SWE-Together** as the preferred future multi-turn benchmark. Its session-to-task construction is closer to real interactive coding work, but removing the replay loop would discard the feature the benchmark was built to measure.

For a defensible SWE-Lancer comparison, give both systems the exact same task checkpoint and text, use the same wall-clock limit and attempt count, prohibit solution lookup, collect the final diff externally, and grade both with the same hidden tests. If results are intended to be comparable to canonical SWE-Lancer rather than only to each other, use the benchmark's supported internet-disabled Linux environment instead of the macOS compatibility path.

## Related

- [Roadmap](./roadmap.md)
- [Project Overview](../project-overview.md)
- [Browser ChatGPT Subagents](../subagents/browser-chatgpt-subagents.md)
