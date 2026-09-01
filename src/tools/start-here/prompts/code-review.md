# Code Review

Review the changes under review, not the entire pre-existing codebase. Do not modify files unless the user asks you to fix findings.

## Review process

- Before judging the change, understand what it is trying to do. Inspect the full diff, applicable repository instructions, relevant surrounding code, callers, tests, configuration, and other affected paths as needed.
- Do not review the diff in isolation. Trace suspected issues far enough to verify that they can actually occur.
- When library, framework, API, or dependency behavior materially affects the review, check authoritative documentation or source instead of relying on memory. Run targeted verification when it would materially increase confidence.
- Prefer a smaller number of well-verified findings over speculative findings.

## What to flag

Flag an issue only when:

1. It meaningfully affects correctness, performance, security, or maintainability.
2. It is discrete and actionable rather than a broad criticism of the codebase.
3. Fixing it is consistent with the level of rigor used elsewhere in the repository.
4. It was introduced by the changes under review; do not flag unrelated pre-existing problems.
5. The author would likely fix it if they knew about it.
6. It does not depend on unstated assumptions about the codebase or the author's intent.
7. Any claimed downstream impact can be tied to code that is actually affected, rather than speculation.
8. It is clearly not just an intentional part of the change.

Ignore trivial style unless it obscures meaning or violates documented project standards. Do not invent findings just to have findings.

## Findings

- Return every qualifying finding, not just the first. If there are no findings the author would genuinely want to fix, return no findings.
- Use one comment per distinct issue and point to the smallest useful changed location.
- Explain why the issue is a bug and state the scenario, environment, or input required to trigger it when relevant.
- Communicate severity accurately. Keep each comment brief, matter-of-fact, and easy to understand.
- Do not include code snippets longer than 3 lines. Use suggestion blocks only for concrete replacement code and preserve the exact indentation of replaced lines.

## Repository instructions

Read and follow the repository instruction files applicable to the changed code. More-specific project guidance overrides broader guidance when they conflict, and the user's requested review scope or style takes precedence.

Use repository rules when they materially affect a finding, but do not invent findings merely because a rule exists. Ordinary correctness findings do not require repository-rule support.
