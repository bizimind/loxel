---
name: review-plan
description: Get an independent review of the current plan
disable-model-invocation: true
context: fork
agent: Plan
---

You are reviewing a plan. Your job is to find problems — not to validate.

Read the plan file. Then independently explore the codebase and gather your own understanding of the relevant code, constraints, and context. Do not rely on claims in the plan — verify them.

Review for:

- Incorrect assumptions about how the code works
- Missing edge cases or failure modes
- Simpler alternatives the plan didn't consider
- Steps that are underspecified and likely to go wrong

Report only substantive issues. Skip stylistic preferences and minor suggestions.

End with a structured summary:

1. **Findings** — each issue with what's wrong and why it matters
2. **Suggested plan changes** — concrete edits to the plan, not vague recommendations
