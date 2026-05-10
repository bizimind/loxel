---
title: "Guide: Reviewing Agent Code"
description: A walkthrough of reviewing AI-generated code with anchored comments that survive rewrites.
order: 17
---

Agent-generated code differs from human PRs: a single task may go through several complete rewrites, and the final diff can be large with no clear narrative. Loxel's review system is built for this — comments survive rewrites, and the full iteration history is there when you need it.

---

## Start a session before the agent runs

Name your review session after the task — not the implementation. "Add OAuth login" is better than "agent run 3". The session accumulates comments across every iteration of the work, not just the final diff.

See [Code Review](/docs/code-review) for how to create a session. Once it's active, any comment you leave in the diff is tracked there.

The session is shared across all worktrees of the repo, so you can start a comment in one worktree and continue it in another.

---

## Walk the diff in split view

Open the diff from the [Git](/docs/git) graph or Changes panel. The [Diff Viewer](/docs/diff-viewer) defaults to split view — old code on the left, new on the right, synchronized scrolling. Your goal at this stage is not to catch every line — it's to understand what the agent built and whether the approach is right: is the abstraction sensible, are the boundaries clean, is this solving the right problem?

Collapsed unchanged regions show as squiggly connectors in the gutter. Click one to expand it when you need context.

---

## Leave intent-based comments

When something catches your attention, anchor a comment to it. Select the relevant lines, click **Add comment** in the gutter, and write what you'd want the agent to understand — not what you'd want it to do.

Good comments ask about intent or raise a concern: "Why was X chosen over Y here?", "Does this handle the empty case?", "Is this logic in the right layer?"

Avoid "fix this" or "wrong" — those don't survive a rewrite. Intent-based comments do.

---

## Iterate

Feed your comments back to the agent as input. When it rewrites the code, loxel re-places every comment using its anchor system — comments end up `exact`, `relocated`, `outdated`, or `lost`. See [Code Review](/docs/code-review) for the full anchor state reference.

`outdated` comments are where the most useful signal lives. The mini-diff under the comment shows the original context in amber — you can see exactly what the agent changed and decide if your concern was addressed or just worked around.

---

## Export when you're done

Click the file icon in the Comments panel header (**Open as markdown**) to export all threads in the active session to a formatted document — grouped by file, with open/resolved status and anchor state. Use it for async discussion, PR descriptions, or just a record of what happened.

---

> **Tip:** resolve threads as you go, not all at once at the end. It's easier to track what's still open when you're mid-iteration and the agent is running again.
