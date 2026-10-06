---
title: Code Review
description: Anchored comments, review sessions, threads, and export.
order: 7
---

Loxel has a built-in code review system that lives in the Comments panel. Comments are anchored to the code they were left on — not to a line number — so they survive code changes, reformats, and repeated agent rewrites.

---

## Starting a review session

Click **Reviews** in the Comments panel header. A dropdown opens; click the new review icon, accept or change the suggested name, then press `Enter` or click **Create**. The session is automatically selected and set as active.

You can have multiple named sessions per repo — one per feature, one per agent run, whatever fits your workflow. In the dropdown, check several sessions to see all their threads at once; the star marks the active session, where new comments go. The pencil icon renames a session. Which sessions are selected and active is remembered per worktree.

---

## Adding comments

Open a diff in the editor (from the commit graph, the Changes panel, or any commit — see [Diff Viewer](/docs/diff-viewer) for the full viewer reference). Commenting needs an active review session and works in the diff viewer's **Split** mode. Then:

1. Select text on either side of the diff, or position your cursor on a line.
2. A floating **Add comment** button appears in the gutter at the end line of your selection.
3. Click it. A comment composer appears with a header showing the line range and side — **parent** (old code) or **current** (new code).
4. Type your comment. Markdown is supported. Submit with `Cmd+Enter` or the **Comment** button.

You can comment on either side of the diff — on the code as it was or as it is now.

---

## How anchors work

Every comment remembers the lines it was left on and a few lines of context around them. When the code changes, Loxel looks for those lines at their original position, then nearby, then anywhere in the file, and finally by their surrounding context. Each comment ends up in one of four anchor states:

| State       | Meaning                                                                        |
| ----------- | ------------------------------------------------------------------------------ |
| `exact`     | Code unchanged at original position                                            |
| `relocated` | Code moved but identical                                                       |
| `outdated`  | Code edited but context lines still match — keeps the original code to compare |
| `lost`      | Code no longer traceable — grouped under "N lost comments" in the panel        |

---

## Outdated comments

When a comment is `outdated`, its expanded thread in the Comments panel shows a collapsed section labeled **"Original code at time of comment"** in amber. It lists the lines as they were when you wrote the comment, so you can compare them with the current code and judge whether the edit addressed your concern or introduced something new.

Click the section header to expand or collapse it.

---

## Threads and replies

Click a thread to expand it. Type in the textarea at the bottom, then submit with `Cmd+Enter` or the Reply button.

To resolve a thread, click the resolve icon. The thread turns gray with a check icon. Click again to reopen it. No confirmation required.

---

## Markdown support

Comments support GitHub Flavored Markdown. You can use:

- Code blocks (fenced with triple backticks)
- Inline code
- Links
- Ordered and unordered lists
- Headings
- Blockquotes

Write comments the same way you'd write a GitHub review.

---

## Exporting a review

Click the file icon in the Comments panel header (**Open as markdown**). Loxel converts all threads in the selected review sessions to a formatted markdown document and opens it as a new [draft](/docs/drafts) in the markdown editor.

The export groups threads by file and includes:

- Open/resolved status for each thread
- The originally commented code, with a `[relocated]` or `[outdated]` tag when the anchor moved or changed
- Lost threads in a separate section
- All replies in order

From there you can move it into the repo, paste it into a PR description, or share it with your team.

---

## Deleting threads and sessions

Click a thread's trash icon (**Delete thread**) to delete it. Individual thread deletion is immediate — no confirmation.

To delete an entire review session, open the Reviews dropdown and delete from there; Loxel asks for confirmation first. Deleting a session also deletes all its threads and comments.

---

## Where reviews are stored

Review sessions live in a SQLite file at `~/.local/state/loxel/loxel/comments/{repoHash}.db`, one per repository, so every worktree of the same repo shares the same reviews — start a review in one worktree, select it in another and pick it up there. See [Core Concepts](/docs/core-concepts#review-as-a-first-class-workflow) for the full mental model.

---

> **Tip:** Leave intent-based comments rather than line-level corrections — "why this approach?", "does this handle the empty case?", "is this the right abstraction boundary?". These survive agent rewrites better than comments tied to a specific implementation detail.

---

## See also

- [Diff Viewer](/docs/diff-viewer) — the diff context where comments are anchored; covers split/unified modes and synchronized scrolling
- [Coding Agent](/docs/coding-agent) — the agent that produces the code you review; iterations feed back into the same review session
- [Guide: Reviewing Agent Code](/docs/guide-reviewing-agent-code) — end-to-end walkthrough of the review workflow
