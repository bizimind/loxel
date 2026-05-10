---
title: Code Review
description: Anchored comments, review sessions, threads, and export.
order: 7
---

Loxel has a built-in code review system that lives in the Comments panel. Comments are anchored to specific lines in a diff using a content fingerprint — not a line number — so they survive code changes, reformats, and repeated agent rewrites.

---

## Starting a review session

Click **Reviews** in the Comments panel header. A dropdown opens; click the new review icon, type a name, then press `Enter` or click **Create**. The session is automatically selected and set as active.

You can have multiple named sessions per repo — one per feature, one per agent run, whatever fits your workflow.

---

## Adding comments

Open a diff in the editor (from the git graph, the Changes panel, or any commit — see [Diff Viewer](/docs/diff-viewer) for the full viewer reference). Then:

1. Select text on either side of the diff, or position your cursor on a line.
2. A floating **Add comment** button appears in the gutter at the end line of your selection.
3. Click it. A comment composer appears with a header showing the line range and side — **parent** (old code) or **current** (new code).
4. Type your comment. Markdown is supported. Submit with `Cmd+Enter` or the Send button.

You can comment on either side of the diff — on the code as it was or as it is now.

---

## How anchors work

Every comment is anchored using an FNV-1a hash of the commented lines plus 3 lines of context before and after. When the underlying code changes, loxel runs a multi-step search to find where the comment belongs:

1. Exact position
2. ±20 lines from original position
3. Full file scan
4. Context match
5. Partial context match
6. Lost

The result is one of four anchor states:

| State       | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `exact`     | Code unchanged at original position                                           |
| `relocated` | Code moved but identical — found within ±20 lines or full file                |
| `outdated`  | Code edited but context lines still match — shows a mini-diff of the original |
| `lost`      | Code no longer traceable — shown in a "Lost Comments" section                 |

---

## Outdated comments

When a comment is `outdated`, the comment card shows a collapsible section labeled **"Original code at time of comment"** in amber. It contains a mini-diff of the lines as they were when you wrote the comment, so you can judge whether the edit addressed your concern or introduced something new.

Click the section header to expand or collapse it.

---

## Threads and replies

Click a thread to expand it. Type in the textarea at the bottom, then submit with `Cmd+Enter` or the Reply button.

To resolve a thread, click the resolve icon. The thread turns gray with a check icon. Click again to reopen it. No confirmation required.

---

## Markdown support

Comments support GitHub Flavored Markdown via `react-markdown` and `remark-gfm`. You can use:

- Code blocks (fenced with triple backticks)
- Inline code
- Links
- Ordered and unordered lists
- Headings
- Blockquotes

Write comments the same way you'd write a GitHub review.

---

## Exporting a review

Click the file icon in the Comments panel header (**Open as markdown**). Loxel converts all threads in the active review session to a formatted markdown document and opens it in a new editor tab.

The export groups threads by file and includes:

- Open/resolved status for each thread
- Anchor state (`exact`, `relocated`, `outdated`, `lost`)
- Original code for outdated comments
- All replies in order

From there you can save it, paste it into a PR description, or share it with your team.

---

## Deleting threads and sessions

Right-click a thread or use its action menu to delete it. Individual thread deletion is immediate — no confirmation.

To delete an entire review session, open the Reviews dropdown and delete from there. Deleting a session cascades to all its threads and comments.

---

## Storage

Review sessions live in a SQLite file at `~/.local/state/loxel/comments/{repoHash}.db`. The hash is keyed by git's common directory, so every worktree of the same repo shares the same review database — start a review in one worktree, pick it up in another. See [Core Concepts](/docs/core-concepts#review-as-a-first-class-workflow) for the full mental model.

---

> **Tip:** Leave intent-based comments rather than line-level corrections — "why this approach?", "does this handle the empty case?", "is this the right abstraction boundary?". These survive agent rewrites better than comments tied to a specific implementation detail.

---

## See also

- [Diff Viewer](/docs/diff-viewer) — the diff context where comments are anchored; covers split/unified modes and synchronized scrolling
- [Coding Agent](/docs/coding-agent) — the agent that produces the code you review; iterations feed back into the same review session
- [Guide: Reviewing Agent Code](/docs/guide-reviewing-agent-code) — end-to-end walkthrough of the review workflow
