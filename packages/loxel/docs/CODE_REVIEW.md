# Code Review and Comments

How reviews and comment threads are stored, anchored to code, placed into a diff, rendered, and exported.

User-facing behavior is documented in the site docs ([code-review.md](../../site/src/content/docs/code-review.md), [guide-reviewing-agent-code.md](../../site/src/content/docs/guide-reviewing-agent-code.md)). This doc covers the internals. Diff rendering and scroll sync are in [DIFF_VIEW_SPEC.md](DIFF_VIEW_SPEC.md); how diff data and its base ref are produced is in [GIT.md](GIT.md).

## Overview

A **review** is a named container of **comment threads**. A thread belongs to exactly one review, is anchored to a line range in one file via a content fingerprint, and holds an ordered list of **comments** (the first one is created with the thread; the rest are replies). Reviews are not bound to a commit: the client chooses which reviews to overlay on whatever diff is open, and the server re-finds each thread's lines in that diff on every fetch.

The flow is:

1. The client creates a thread from a line selection in the side-by-side diff, computing the content anchor from the full file text it already loaded.
2. The server persists the thread and anchor verbatim in a per-repo SQLite database.
3. Whenever the diff or the review selection changes, the client posts the diff's file list to `POST /api/placed-threads`; the server reads both sides of each file at the diff's refs, relocates every anchor, and returns `PlacedThread`s with display coordinates and an anchor status.
4. The client stores placed threads in a Zustand store; the diff gutter, Monaco decorations, and the Comments panel all render from it.

## Data model

Schemas live in [review-model.ts](../src/api/review-model.ts) and [comment-model.ts](../src/api/comment-model.ts). They are zod schemas with inferred types, shared by server and client.

- `Review`: `id`, `name`, `context: ReviewContext`, timestamps, optional `threadCount` (filled by list/update queries).
- `ReviewContext`: `commitHashes`, `branchName`, `headCommit`, `worktreePath`. It is metadata used only to sort the review picker by relevance; nothing on the server filters by it.
- `CommentThread`: `reviewId`, `filePath`, `createdSide` (`old` | `new`), `contentAnchor`, `startLine`/`endLine` (1-based, at creation time), `status` (`open` | `resolved`), timestamps, `comments`.
- `Comment`: `threadId`, `body` (markdown), `authorName` (nullable), timestamps.
- `PlacedThread`: a `CommentThread` plus server-computed `displaySide`, `displayStartLine`, `displayEndLine`, `anchorStatus` (`exact` | `relocated` | `outdated` | `lost`), and for `outdated` only, `originalContent` and `currentContent`.
- `DiffFileContext`: what the client sends per diff file: `oldPath`, `newPath`, `oldRef`, `newRef` (null means "not a ref"), optional `worktreePath`.

Request bodies (`CreateThreadRequest`, `CreateReviewRequest`, `UpdateReviewRequest`, `UpdateThreadRequest`, `AddReplyRequest`, `PlacedThreadsRequest`) are defined in the same file and validated with `safeParse` in the routes.

## Storage

[review-db.ts](../src/server/review-db.ts) owns persistence via `bun:sqlite`.

- **Scope: one database per repository.** `ReviewDb.open(cwd)` hashes the realpath of `git rev-parse --git-common-dir` (SHA-256, first 32 hex chars) and opens `<stateDir>/comments/<hash>.db` ([config.ts](../src/server/config.ts) `commentsDir`). Because the common dir is shared, every worktree of a repo sees the same reviews. There is no per-worktree partitioning anywhere on the server.
- **Lifecycle.** The server opens one `ReviewDb` per registered project in `initializeProject` and closes it in `teardownProject` ([server.ts](../src/server/server.ts)); it is held on `ProjectState.reviewDb` ([server-state.ts](../src/server/server-state.ts)). Project state and the per-project/per-worktree split are covered in [SHARED_SERVER.md](SHARED_SERVER.md) and [STATE_AND_STORAGE.md](STATE_AND_STORAGE.md).
- **Pragmas.** WAL journal, `busy_timeout = 5000`, `foreign_keys = ON`.
- **Tables.** `reviews(id, name, context JSON, created_at, updated_at)`; `comment_threads(id, review_id → reviews ON DELETE CASCADE, file_path, created_side, content_anchor JSON, start_line, end_line, status, ...)` with `CHECK`s on side, status, `start_line >= 1`, `end_line >= start_line`; `comments(id, thread_id → comment_threads ON DELETE CASCADE, body, author_name, ...)`. Indexes on `comment_threads(review_id)`, `comment_threads(file_path)`, `comments(thread_id)`.
- **Keys.** All ids are `crypto.randomUUID()`. Timestamps are ISO strings. JSON columns are parsed back through zod on read (`ReviewContextSchema`, `ContentAnchorSchema`), and every row goes through a row schema before mapping to the API model.
- **Writes.** `createThread` inserts the thread and its first comment and bumps `reviews.updated_at` in one transaction; `addReply` does the same for a reply plus the thread's `updated_at`. `listReviews` orders by `updated_at DESC`.
- **Author.** `authorName` is `git config user.name` read once per project at init (`getGitAuthorName`) and stamped on every comment server-side; clients cannot set it.
- **Migration.** `PRAGMA user_version` is the schema version. `migrateToV2` drops the old tables and recreates them when the version is below 2 (the comment notes the system had not shipped). Any future migration must be additive; do not copy the drop-and-recreate pattern.

## HTTP API

[review-routes.ts](../src/server/review-routes.ts) exposes `handleReviewRequest`, which returns `null` for unmatched paths. [routes.ts](../src/server/routes.ts) dispatches `/api/reviews*`, `/api/placed-threads`, and `/api/comments/threads*` to it after `resolveProjectFromReq` maps the `project` or `wt` query parameter to its owning project. The route context is `{ reviewDb, cwd: project.cwd, authorName }`.

| Method and path                           | Purpose                                         |
| ----------------------------------------- | ----------------------------------------------- |
| `GET /api/reviews`                        | All reviews in the repo with `threadCount`      |
| `POST /api/reviews`                       | Create (name trimmed)                           |
| `PATCH /api/reviews/:id`                  | Rename and/or replace context                   |
| `DELETE /api/reviews/:id`                 | Delete; threads and comments cascade            |
| `POST /api/placed-threads`                | Relocate threads of `reviewIds` against `files` |
| `POST /api/comments/threads`              | Create thread with first comment                |
| `PATCH /api/comments/threads/:id`         | Set `status`                                    |
| `DELETE /api/comments/threads/:id`        | Delete thread; comments cascade                 |
| `POST /api/comments/threads/:id/comments` | Add reply                                       |

Client wrappers are in [client.ts](../src/api/client.ts) (`getReviews`, `postPlacedThreads`, `createCommentThread`, ...); all take the active worktree path and send it as `wt`.

## Anchoring and placement

### The anchor

[content-anchor.ts](../src/lib/content-anchor.ts) is shared code (it runs in the renderer to create anchors and on the server to relocate them). `createContentAnchor(lines, startLine, endLine)` stores:

- `content`: the selected lines verbatim.
- `contextBefore` / `contextAfter`: up to 3 lines on each side (`CONTEXT_LINES`), truncated at file boundaries.
- `contentHash`: FNV-1a of `content.join("\n")`.

The anchor and the creation-time `startLine`/`endLine` are immutable. Relocated positions are computed per request and never written back, so every placement starts from the original stored line.

### Relocation

`relocateAnchor(anchor, currentLines, storedStart)` tries, in order, and returns the first hit:

1. `exact`: `content` matches at the stored line.
2. `relocated`: `content` matches within ±20 lines (`SEARCH_RADIUS`), searching outward alternately above and below.
3. `relocated`: `content` matches anywhere in the file (same outward search with the file length as radius).
4. `outdated`: all of `contextBefore` and `contextAfter` match around a candidate position within ±100 lines (`CONTEXT_SEARCH_RADIUS`), so the content between them changed.
5. `outdated`: at least `min(2, longest context length)` lines of either context side match within ±100 lines.
6. `lost`.

Matching is exact string equality per line; there is no whitespace normalization. For `outdated`, the returned range keeps the original `content.length`, so a commented block that grew or shrank is displayed with its old height. If both context arrays are empty (the selection covered the whole file), step 4 matches at the first in-bounds position near the stored line.

### Placement against a diff

[placement.ts](../src/server/placement.ts) `placeThreads(cwd, threads, files)`:

- Reads each file side once (deduplicated by `ref:path`), in parallel: a ref is read with `git.getFileContent`; a null ref with a `worktreePath` reads the working tree (uncommitted diffs); otherwise the side is empty. Read failures become empty files.
- Indexes files by both `oldPath` and `newPath`, so threads created on either name of a renamed file are found.
- Relocates against the thread's `createdSide` first; if that is `lost`, tries the other side and, on success, sets `displaySide` to it. So a thread created on a removed line can still be shown on the new side if its content appears there, and vice versa.
- For `outdated`, attaches `originalContent` (the anchor) and `currentContent` (the lines now at the placed range).
- Threads that are lost on both sides come back with `anchorStatus: "lost"` and their stored lines.

Which threads are considered: the route calls `listThreads(reviewIds, allPaths)` with every old/new path in the request, so threads on files that are not in the current diff are not returned at all. They are neither placed nor lost; they reappear when a diff includes their file.

## Client state

- [worktree-reviews.ts](../src/store/worktree-reviews.ts) (`useReviewStore`): per-worktree, in-memory store built with `createWorktreeStore` ([worktree-store.ts](../src/store/worktree-store.ts)), so each worktree has its own `selectedReviewIds` and `activeReviewId` and they are dropped on worktree removal via `purgeWorktreeStores`. Selection is not persisted across reloads. The review list itself is fetched from the shared repo DB. Invariants maintained by the actions: the active review is always selected (`setActiveReview` adds it; deselecting the active review clears it); `createReview` selects and activates the new review; toggling a review on when none is active makes it active. Multi-select controls which reviews are overlaid; only the active review receives new threads.
- [comments.ts](../src/store/comments.ts) (`useCommentStore`): a single global store (not per-worktree) holding `placedThreadsByFile` (keyed by `thread.filePath`), `lostThreads`, `activeThreadId`, and `pendingAnchor` (the side and line range being commented on). `activeThreadId` and `pendingAnchor` are mutually exclusive. It is cleared by `transitionWorktreeState` in [worktree-cache.ts](../src/store/worktree-cache.ts) on every worktree switch because placements are diff-specific. Mutations call the API and patch local state instead of refetching: a new thread is inserted optimistically as `exact` at its creation lines; resolve/reopen update only `status`, `comments`, and `updatedAt`, preserving display fields.
- [useReviewContext.ts](../src/hooks/useReviewContext.ts): derives a `ReviewContext` and default review name from the repository store's `diffSource` (uncommitted, commit, or range). The parent hash it derives is a naming label only; the rendering base is the server-resolved `DiffInfo.baseRef` (see [GIT.md](GIT.md)).

## Rendering in the diff viewer

[DiffViewerPanel.tsx](../src/components/diff-viewer/DiffViewerPanel.tsx) `DiffContent` builds the `DiffFileContext[]` from the diff (`oldRef` = `diff.baseRef`, `newRef` = the commit hash or null, `worktreePath` for uncommitted diffs) and calls `fetchPlacedThreads` whenever that list or `selectedReviewIds` changes; with no reviews selected it calls `clearAll`. The fetch happens in both view modes, so the Comments panel is populated either way.

Commenting and inline markers exist only in [SideBySideDiffView.tsx](../src/components/diff/SideBySideDiffView.tsx), which `FileDiffView` uses when the view mode is `split` and there is a commit hash or worktree path. The unified view and the hunk-based fallback (`HunkBasedDiffView`) render no comment UI. The reason is structural: the side-by-side view loads the full content of both file versions into two Monaco editors, which gives real file line numbers on each side and the surrounding lines needed for the anchor's context; the hunk-based view only has hunk lines.

Inside the side-by-side view:

- Threads for the file are looked up under both the new and old path (renames) and passed to each side.
- [LineNumbersColumn.tsx](../src/components/diff/LineNumbersColumn.tsx) renders the gutter: stripes on commented lines, an icon on each thread's first line, resolved styling, and drag-to-select line ranges. A single-line click inside an existing thread on that side sets `activeThreadId`; any other selection sets `pendingAnchor`.
- [comment-decorations.ts](../src/components/comments/comment-decorations.ts) builds whole-line Monaco decorations filtered by `displaySide`, applied by [EditorPanel.tsx](../src/components/diff/EditorPanel.tsx); `outdated` takes precedence over `resolved` for styling.
- [AddCommentButton.tsx](../src/components/comments/AddCommentButton.tsx) floats next to an editor selection or caret and converts it into a `pendingAnchor`.
- [CommentComposer.tsx](../src/components/comments/CommentComposer.tsx) is portaled below the pending range, follows scroll, and on submit calls `createContentAnchor` on that side's loaded lines and `createThread` with `filePath` set to `oldPath` for the old side and the new path for the new side. It renders only when there is an `activeReviewId`.
- Changing file clears `pendingAnchor` and `activeThreadId`.

Thread bodies, replies, resolve/delete, and the lost-thread group are not rendered inline in the diff; they live in [CommentsPanel.tsx](../src/components/panels/CommentsPanel.tsx), which hosts [ReviewSelector.tsx](../src/components/reviews/ReviewSelector.tsx), expands the thread matching `activeThreadId`, renders bodies with [CommentMarkdown.tsx](../src/components/comments/CommentMarkdown.tsx), and shows [OutdatedDiff.tsx](../src/components/comments/OutdatedDiff.tsx) for `outdated` threads. Clicking a thread in the panel also selects its file in the diff viewer. Panel registration is covered in [PANELS_AND_LAYOUT.md](PANELS_AND_LAYOUT.md).

`ReviewSelector` sorts reviews by a relevance score against the current `ReviewContext` (+10 any shared commit hash, +5 same branch name, +3 same worktree path), then by `updatedAt`.

## Export to markdown

[threads-to-markdown.ts](../src/lib/threads-to-markdown.ts) `threadsToMarkdown` turns the current `placedThreadsByFile` and `lostThreads` into one document aimed at both humans and agents:

- Header with the selected review names and an open/resolved summary across N files.
- One `##` section per file (alphabetical), threads sorted open-first then by display line, each as `### Line(s) X[-Y] -- OPEN|RESOLVED` with a `[relocated]`/`[outdated]` tag, an outdated note, the anchored code in a fenced block with a language inferred from the extension, then the comments.
- A "Lost Comments" section using stored line numbers.
- If every comment has the same author, names and timestamps are omitted and replies render as blockquotes; otherwise each comment is prefixed with the bold author name. Timestamps are never included.

The code block shows the anchor's original `content`, not the current lines, and only threads that are currently placed or lost appear (threads on files outside the open diff are absent, see above). The Comments panel dispatches `loxel-create-editor-with-content`, handled in [useLoxelEventListeners.ts](../src/hooks/useLoxelEventListeners.ts) by `createEditor` in [panel-creators.ts](../src/lib/panel-creators.ts), which creates a detached markdown note with that content. Drafts and detached notes are described in [EDITOR.md](EDITOR.md).

## Relationship to git state

- Reviews track no commits authoritatively. `ReviewContext` is a snapshot taken at creation (replaceable via PATCH) used only for picker sorting. A review created on one commit overlays onto any diff that touches the same files.
- Threads are tied to file paths and content, not SHAs. After a rebase, amend, or squash the anchored lines are found again by content in whatever refs the current diff uses; the stored `startLine` only seeds the search. Old commit hashes in `ReviewContext` simply stop matching.
- Uncommitted diffs read the new side from the working tree of the diff's `worktreePath`, so placement follows edits as soon as the diff data changes ([WATCHERS.md](WATCHERS.md) covers what triggers that).
- Removing a worktree drops its client-side selection state but does not touch the database: its reviews remain visible from every other worktree of the repo, and the stale `worktreePath` only lowers their sort score. Worktree lifecycle is in [PROJECTS_AND_WORKTREES.md](PROJECTS_AND_WORKTREES.md).
- Deleting a project tears down its `ReviewDb` handle but leaves the `.db` file on disk.

## Extending safely

- **Adding a field to threads or comments.** Update the zod schema in `review-model.ts` (the API type derives from it), add the column to the SQLite schema behind a new `user_version` step that uses `ALTER TABLE` (do not drop tables), extend the row schema and row-to-model mapper in `review-db.ts`, the insert statements, and the request schema if clients set it. `PlacedThread` extends `CommentThread`, so it picks up the field; check `updateThreadInState` in `comments.ts`, which copies only selected fields from server responses.
- **Changing anchor logic.** Stored anchors are permanent, so `relocateAnchor` must keep working for anchors created by every previous version. Prefer adding new steps or optional anchor fields over changing what existing fields mean; if `ContentAnchorSchema` gains a required field, existing rows will fail `ContentAnchorSchema.parse` on read. Keep the status semantics (`exact` / `relocated` mean the content is unchanged, `outdated` means only context matched), since decorations, the panel badge, and the markdown export key off them. `content-anchor.ts` runs in both the renderer and Bun, so it must stay free of Node or DOM APIs.
- **Tests.** Anchor creation and relocation: [content-anchor.test.ts](../src/lib/content-anchor.test.ts). Two-sided placement, renames, outdated content: [placement.test.ts](../src/server/placement.test.ts) (mocks `git-commands`). Export format: [threads-to-markdown.test.ts](../src/lib/threads-to-markdown.test.ts).

## Where to look

- [src/api/review-model.ts](../src/api/review-model.ts), [src/api/comment-model.ts](../src/api/comment-model.ts): schemas and types
- [src/server/review-db.ts](../src/server/review-db.ts): SQLite storage
- [src/server/review-routes.ts](../src/server/review-routes.ts): HTTP handlers
- [src/server/placement.ts](../src/server/placement.ts): two-sided placement
- [src/lib/content-anchor.ts](../src/lib/content-anchor.ts): anchor creation and relocation
- [src/store/worktree-reviews.ts](../src/store/worktree-reviews.ts), [src/store/comments.ts](../src/store/comments.ts): client state
- [src/components/diff/SideBySideDiffView.tsx](../src/components/diff/SideBySideDiffView.tsx), [src/components/comments/](../src/components/comments/): diff integration
- [src/components/panels/CommentsPanel.tsx](../src/components/panels/CommentsPanel.tsx), [src/components/reviews/ReviewSelector.tsx](../src/components/reviews/ReviewSelector.tsx): panel UI
- [src/lib/threads-to-markdown.ts](../src/lib/threads-to-markdown.ts): export
