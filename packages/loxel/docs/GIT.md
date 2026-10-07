# Git layer

How Loxel reads and mutates Git state end to end: the server's command and parser modules, the status pipeline, how diffs are selected and resolved, the commit graph, and the invariants to keep when changing any of them.

Related docs: [WATCHERS.md](WATCHERS.md) (what triggers refreshes), [SHARED_SERVER.md](SHARED_SERVER.md) (one server per mode), [DIFF_VIEW_SPEC.md](DIFF_VIEW_SPEC.md) (diff rendering and scrolling), [PROJECTS_AND_WORKTREES.md](PROJECTS_AND_WORKTREES.md) (worktree create/remove), [CODE_REVIEW.md](CODE_REVIEW.md) (comment placement on diffs), [ARCHITECTURE.md](ARCHITECTURE.md).

## Command layer

Every Git read the UI depends on goes through [`src/server/git-commands/`](../src/server/git-commands/), imported by the server as a single barrel ([index.ts](../src/server/git-commands/index.ts)). Commands are Bun shell template literals (`` $`git -C ${cwd} ...` ``), so arguments are passed as separate argv entries rather than through a shell string. Hunk staging uses `Bun.spawn` with the patch on stdin.

| Module                                                        | Owns                                                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [git-env.ts](../src/server/git-commands/git-env.ts)           | `readOnlyGitEnv()` and `SUBMODULE_GITLINK_ONLY`, the single source of truth for how Loxel invokes Git |
| [status.ts](../src/server/git-commands/status.ts)             | `getStatus`: the one `git status --porcelain=v2 --branch -z` reader                                   |
| [diff.ts](../src/server/git-commands/diff.ts)                 | staged, unstaged, commit, range and working-tree diffs; `resolveCommit`, `resolveMergeBase`           |
| [log.ts](../src/server/git-commands/log.ts)                   | `getLog` (graph) and `getBranchCommits` (the commits a branch adds over the default branch)           |
| [refs.ts](../src/server/git-commands/refs.ts)                 | refs, branches with reflog timestamps, recent branch names, stashes                                   |
| [repo.ts](../src/server/git-commands/repo.ts)                 | `isBareRepo`, `getGitRoot`, `resolveDefaultBranchRef`                                                 |
| [worktree.ts](../src/server/git-commands/worktree.ts)         | `git worktree list` parsing, `validateWorktreePath`, the cross-worktree status sweep                  |
| [file-content.ts](../src/server/git-commands/file-content.ts) | file content at a ref (`git show`) or from a worktree's disk                                          |
| [staging.ts](../src/server/git-commands/staging.ts)           | stage/unstage files and hunks, `discardChanges`, `revertToHead`                                       |
| [operations.ts](../src/server/git-commands/operations.ts)     | commit, checkout, reset, cherry-pick, revert, branch create/delete/rename, stash                      |
| [validation.ts](../src/server/git-commands/validation.ts)     | allowlist regexes for commit hashes, ref names and relative paths                                     |
| [concurrency.ts](../src/server/git-commands/concurrency.ts)   | `mapWithConcurrency`, an order-preserving bounded pool                                                |

Inputs from clients are validated before they reach Git: hashes against `^[a-f0-9]{4,40}$`, refs against a conservative character allowlist, paths against `..` and reserved characters. Working-tree reads additionally call `validateWorktreePath`, which accepts only paths that `git worktree list` reports for the project (one extra `git worktree list` per request).

REST handlers live in [routes.ts](../src/server/routes.ts) (`/api/status`, `/api/diff`, `/api/graph`, `/api/log`, `/api/branch-commits`, `/api/refs`, `/api/branches`, `/api/branches/recent`, `/api/file-content`, `/api/file-lines`, `/api/worktree-statuses`, and the POST mutations). Query-string routes resolve either the project (`project.cwd`) or the worktree (`wt`); mutations read `worktreePath` from the body. Which one a handler passes to Git matters, see [Invariants](#invariants).

Not every Git call lives here. Project setup (`init`, `clone`) is in `routes.ts`, the diagnostics temp worktree is in [diagnostics.ts](../src/server/diagnostics.ts), the ignored-files listing is in [project-files-service.ts](../src/server/project-files-service.ts), and explorer file operations in [file-operations-service.ts](../src/server/file-operations-service.ts) use `git mv`, `git rm` and `git add` for tracked files, so moves and deletes from the explorer change the index.

### Read-only environment

All read paths run with `readOnlyGitEnv()`: a copy of `process.env` (Bun's `.env()` replaces rather than merges the environment, so `PATH`/`HOME` must be copied) plus `GIT_OPTIONAL_LOCKS=0`. Without it, `git status` refreshes the index and writes `index.lock` on every call, which the Git-directory watcher reports as a status change, which runs another status: a feedback loop. Mutating commands in `operations.ts` and `staging.ts` deliberately do not use it. The working-tree diff's untracked half goes further and writes its intent-to-add entries to a throwaway index and object directory in a temp dir; see [WATCHERS.md](WATCHERS.md#git-directory-events) for why nothing a read path runs may touch `objects/`.

Loxel never passes `-c core.fsmonitor=true`. Because `GIT_OPTIONAL_LOCKS=0` prevents Git from saving the fsmonitor token, forcing it gains nothing and leaves a daemon per Git directory (submodules included). Whether fsmonitor runs is the user's Git configuration; the full rationale is in [WATCHERS.md](WATCHERS.md#external-processes).

### Parsers

[`src/server/parsers/`](../src/server/parsers/) turns command output into the types in [git-models.ts](../src/api/git-models.ts) and [diff-model.ts](../src/api/diff-model.ts). Parsers are pure and skip malformed records rather than throwing.

- [status.ts](../src/server/parsers/status.ts) parses porcelain v2 with `-z`. `-z` is required: without it Git C-quotes non-ASCII and special paths, which then match nothing on disk. Paths are taken verbatim after the fixed fields, so spaces are safe; a rename record consumes the following NUL field as the original path. `u` records go to `conflicted` only. Status letters other than `A M D R C U` (for example `T`, type change) map to `M`.
- [diff.ts](../src/server/parsers/diff.ts) splits unified diff output on `diff --git` headers and decodes C-quoted header paths per side, including octal-escaped UTF-8 bytes. An all-unquoted header is split on its last ` b/`, so it is ambiguous only when a path itself contains ` b/`. File status and `Binary files` are detected from the first ten header lines; binary files get no hunks. `\ No newline at end of file` is kept as a `normal` line without line numbers. The parser cannot know the diff's base, so callers attach `baseRef`.
- [log.ts](../src/server/parsers/log.ts) parses `LOG_FORMAT`, NUL-separated fields one commit per line (only the subject is requested, so no field contains a newline). `%D` decorations are classified as `HEAD`, local branch, remote branch or tag.
- [refs.ts](../src/server/parsers/refs.ts) parses space-separated `for-each-ref` output and `[ahead N, behind M]` tracking. Only `origin/HEAD` is skipped among remote symbolic refs. Stash entries carry index and message only (`commit` and `date` are empty strings).
- `parseWorktreeListOutput` in [worktree.ts](../src/server/git-commands/worktree.ts) parses `worktree list --porcelain` (not `-z`). The main worktree is marked `isMain`; a `bare` entry is dropped.

### worktree-utils.ts

[worktree-utils.ts](../src/server/worktree-utils.ts) is not a Git wrapper. It holds `INTERNAL_WORKTREE_PREFIX` (the name prefix of Loxel's temporary worktrees, filtered out of every worktree list and status sweep and pruned at project init, see [SHARED_SERVER.md](SHARED_SERVER.md#persistent-state)), `REF_PATTERN`, `symlinkNodeModules` (used by the diagnostics temp worktree) and `findWorkspacePackages`.

## Status pipeline

Git status reaches clients through two channels, both described operationally in [WATCHERS.md](WATCHERS.md#status-refresh-pipeline):

1. **Per worktree.** A subscribed worktree's `ProjectFilesService` is the single reader of its status. Each coalesced pass runs `getStatus` and the ignored-files listing; `publishWorktreeStatus` in [server.ts](../src/server/server.ts) broadcasts `status_changed { wtPath, data: StatusInfo }` to that worktree's subscribers and hands the same snapshot to the project's tracker. `GET /api/status` always runs a fresh `getStatus`, so it reflects a just-finished mutation.
2. **Per project.** [worktree-status-tracker.ts](../src/server/worktree-status-tracker.ts) (`WorktreeStatusTracker`, one per `ProjectState`) owns the list of dirty worktrees: live snapshots for subscribed worktrees, sweeps (`readWorktreeStatuses`) for the rest; sweep scheduling is described in [WATCHERS.md](WATCHERS.md#status-refresh-pipeline). Code-level details not covered there: `invalidate()` (on `log` and `worktrees` events, on first subscribe, and after a failed removal resumes) schedules a sweep after 250 ms (`URGENT_SWEEP_DELAY_MS`), sweeps use generation counting, and they skip entirely while no client is subscribed to the project. The list is pushed as `worktree_status_changed { projectPath, data }` only when its JSON differs from the last one published.

A worktree is "dirty" when it has staged, unstaged, untracked or conflicted entries (`toDirtyWorktreeStatus`).

Project-level Git events from the project `FileWatcher` (set up in `initializeProject` in [server.ts](../src/server/server.ts)) map to messages as follows: `status` requests a pass in every subscribed worktree of the project; `refs` broadcasts `refs_changed` with the output of `getRefs`; `log` broadcasts `log_changed` and invalidates the tracker; `worktrees` broadcasts `worktrees_changed`, reconciles removed worktrees and invalidates the tracker. Bare projects only receive `refs`, `log` and `worktrees`.

On the client, [ws-bridge.ts](../src/queries/ws-bridge.ts) writes `status_changed` and `worktree_status_changed` straight into the query cache and invalidates working-tree diffs (`isWorkingTreeDiffKey` in [query-keys.ts](../src/queries/query-keys.ts)). `refs_changed` and `log_changed` invalidate the commits and branch-commits queries and working-tree diffs. Commit and range diffs are keyed by full SHAs and never refetched.

Where to look: [status.ts](../src/server/git-commands/status.ts), [worktree.ts](../src/server/git-commands/worktree.ts), [worktree-status-tracker.ts](../src/server/worktree-status-tracker.ts), [server.ts](../src/server/server.ts) (`publishWorktreeStatus`, `liveWorktreeStatus`, `initializeProject`), [ws-protocol.ts](../src/api/ws-protocol.ts), [ws-bridge.ts](../src/queries/ws-bridge.ts), [use-repo-queries.ts](../src/queries/use-repo-queries.ts).

## Diff data

### Selection to diff source

Commit selection is per-worktree state in [worktree-repository.ts](../src/store/worktree-repository.ts) (`selectedCommits`, `diffSource`). [useDiffSource](../src/hooks/useDiffSource.ts), mounted once in `App.tsx`, derives `diffSource` from the selection so it stays current regardless of which panels are open:

| Selection                         | `DiffSource`                                         | Server call                                          |
| --------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| nothing                           | auto-selects the active worktree's uncommitted entry | —                                                    |
| one uncommitted entry             | `{ type: "uncommitted", worktree }`                  | `getWorkingTreeDiff` against `HEAD` of that worktree |
| one commit                        | `{ type: "commit", commit }`                         | `getCommitDiff` (`git diff-tree -p --root`)          |
| commits plus an uncommitted entry | `{ type: "uncommitted", worktree, base }`            | `getWorkingTreeDiff` against `base`                  |
| several commits                   | `{ type: "range", range: "<base>..<newest>" }`       | `getRangeDiff`                                       |

Uncommitted entries are virtual commits whose hash is `UNCOMMITTED_PREFIX + worktreePath` ([uncommitted-commits.ts](../src/lib/uncommitted-commits.ts), [git-models.ts](../src/api/git-models.ts)). Multi-commit selections are diffed as one range from the oldest to the newest selected commit.

Ordering comes from [useCommitLookup](../src/hooks/useCommitLookup.ts) over [useAllKnownCommits](../src/hooks/useAllKnownCommits.ts): the graph's commits (with uncommitted rows, from [useCommitsWithUncommitted](../src/hooks/useCommitsWithUncommitted.ts)) followed by any branch-dropdown commits the graph does not contain, so a selection made in the Changes panel's branch dropdown resolves even when the graph's filter hides those commits. "Newest" and "oldest" are list positions in that topologically ordered array. [useDiffTitle](../src/hooks/useDiffTitle.ts) derives the panel title from the same lookup and the branch commits.

### Diff base

[`resolveDiffBase`](../src/hooks/diff-base.ts) picks the old side. For a selection that covers the whole branch (bottom to tip, or bottom to the working tree, and the branch list is not truncated) it returns the branch's merge base with the default branch, which is what a pull request compares against; otherwise it returns the first parent of the oldest selected commit. The merge base is wrong for any sub-range because it need not be an ancestor of an older commit, and the first parent is wrong for the whole branch once the branch has merged the default branch in. If the oldest commit is a root commit, the base is the empty tree.

The branch and its merge base come from `getBranchCommits` in [log.ts](../src/server/git-commands/log.ts): `git log <merge-base>..HEAD` in the worktree, against `resolveDefaultBranchRef` in [repo.ts](../src/server/git-commands/repo.ts). That resolver tries, in order: a remote's `HEAD` (preferring `origin`), `origin/main`, `origin/master`, a bare repository's own `HEAD` if that branch exists, then `init.defaultBranch`, `main` and `master`. `branch.<name>.merge` is deliberately ignored, since a topic branch's upstream is usually its own remote copy. Exclusion by reachability against all other refs was replaced because stacked branches and stale refs truncated the list. With no default ref or the default branch checked out, the result is up to 20 recent commits with `mergeBase: null`; a detached `HEAD` returns only the single `HEAD` commit. The server requests `limit + 1` commits to report `truncated`.

### `baseRef` is resolved on the server

Every `DiffInfo` carries `baseRef`: the old side as a full SHA, or null (root commit, or unstaged diff whose old side is the index). It is resolved with `rev-parse --verify <rev>^{commit}` in the repository where the diff ran: a working-tree diff resolves `HEAD` in the worktree, not in the project. A symbolic ref cannot be sent to the client because `HEAD` names different commits in a linked worktree and in the project repository, while a SHA is the same object in the shared store. The diff viewer uses `diff.baseRef` for the old side of the side-by-side view and for review placement; it never re-derives it ([DiffViewerPanel.tsx](../src/components/diff-viewer/DiffViewerPanel.tsx)).

### Working-tree diff and the Changes panel

`getWorkingTreeDiff` runs, in parallel, `git diff <baseRef>` in the worktree (tracked changes, staged and unstaged combined, against a commit) and the untracked half: untracked files are listed with `ls-files --others --exclude-standard -z`, recorded as intent-to-add in a throwaway index and object store, and diffed in one `git diff` instead of one process per file. If that fails (a file vanished twice, a sparse-checkout refusal, an unreadable file) it falls back to per-file `git diff --no-index` with at most eight in flight. Nested repositories (entries ending in `/`) are skipped.

The Changes panel ([FileTreePanel.tsx](../src/components/panels/FileTreePanel.tsx)) renders `useDiffQuery(diffSource)`. Its default "against HEAD" tree is therefore the working-tree diff of the active worktree against its own `HEAD`: staged, unstaged and untracked changes merged into one list, built client-side into a compacted tree from each `FileDiff` path by `buildDiffFileTree` in [diff-file-tree.ts](../src/lib/diff-file-tree.ts). Discard is offered only for this case (`uncommitted` with no `base`) and calls `revertToHead`, which classifies each requested path by Git's own status and then runs `git restore --source=HEAD --staged --worktree` for tracked paths and `git clean` for untracked ones, with literal pathspecs. Both sides of a rename are reverted.

The file the diff viewer shows is `selectedDiffFile` in [worktree-ui.ts](../src/store/worktree-ui.ts), shared by the Changes panel and the diff viewer through [useDiffFileSelection](../src/hooks/useDiffFileSelection.ts). Both read the files in Changes tree order (`orderDiffFiles`, a depth-first walk of `buildDiffFileTree`) rather than Git's order, which lists untracked files last. The diff viewer's previous/next file and its "File N of M" counter follow that order, and when the selection is empty or no longer in the diff, the first file in that order is selected. In the Changes panel only a click on a file row (`FilesTree`'s `onFileClick`) and `onOpen` (Enter, double-click, the context menu's Open Diff) change the selection; moving keyboard focus does not. `revealActivePath` makes the tree expand and scroll to a selection made from the diff viewer (see [FILES_TREE.md](FILES_TREE.md#focus-selection-and-active-rows)).

### Highlighting

[DiffViewerPanel.tsx](../src/components/diff-viewer/DiffViewerPanel.tsx) renders the true side-by-side view ([SideBySideDiffView.tsx](../src/components/diff/SideBySideDiffView.tsx)) as two Monaco editors over full file contents when in split mode with a commit or worktree context, so highlighting there is Monaco's (see [EDITOR.md](EDITOR.md)). Otherwise it renders hunks only, highlighted with Shiki by [useSyntaxHighlight](../src/hooks/useSyntaxHighlight.ts) through `highlightCode` in [highlighter.ts](../src/lib/highlighter.ts), using `github-dark` or `github-light` according to `darkMode`.

### Collapsed regions

[useCollapsedRegions](../src/hooks/useCollapsedRegions.ts) holds the expanded set of unchanged regions for one file in the side-by-side view, computed by `buildCollapsibleRegions`/`computeHiddenRanges` in [unchanged-regions.ts](../src/components/diff/unchanged-regions.ts), and resets it when the hunks array changes identity. Rendering and scroll alignment are in [DIFF_VIEW_SPEC.md](DIFF_VIEW_SPEC.md).

## Commit graph

[GraphPanel.tsx](../src/components/graph/GraphPanel.tsx) hosts the branch list, the header (search, filters, branch preset) and [CommitGraph.tsx](../src/components/graph/CommitGraph.tsx).

- **Data source.** `useCommitsQuery(preset)` calls `GET /api/graph`, which returns `getLog` (`--topo-order`, limit 200 from the client) and `getRefs` in one response. Preset `all` requests `--all`; `current-and-main` logs the current and default branches; `recent-Nd` first calls `/api/branches/recent` (local branches by latest reflog entry, remote branches by committer date) and logs only those, returning an empty graph when none qualify.
- **Uncommitted rows.** `injectUncommittedCommits` in [uncommitted-commits.ts](../src/lib/uncommitted-commits.ts) adds one virtual commit per dirty worktree from the tracker's list (`worktreeStatuses`), parented on that worktree's `HEAD` and inserted just before it. A worktree whose `HEAD` is not in the visible list gets no row. The row counts untracked files with unstaged ones.
- **Filters.** Search text, branch, author and date filters are applied client-side in `CommitGraph` before layout. Uncommitted rows match a branch filter through their parent's refs and are excluded by author and date filters.
- **Layout.** `calculateLayout` in [layout.ts](../src/components/graph/layout.ts) is a single pass over the topologically ordered list that assigns swim lanes: a commit without a visible child takes the leftmost free lane, a first parent inherits its child's lane, merge parents get their own lane, and a lane is freed when its owner's first parent is not visible or already has another lane. Colors come from the primary ref (HEAD, local, remote, tag) via `getBranchColor`, else from the first child; uncommitted nodes take their parent's branch color and draw a dashed edge. Because filtering happens before layout, a filtered list is laid out as if hidden commits did not exist. All rows are rendered (no virtualization); the 200-commit limit bounds the cost.
- **Default branch.** `resolveDefaultBranchRef` is used by `getBranchCommits` (the Changes panel's branch dropdown and the diff base above) and by the `current-and-main` preset.

Where to look: [GraphPanel.tsx](../src/components/graph/GraphPanel.tsx), [CommitGraph.tsx](../src/components/graph/CommitGraph.tsx), [layout.ts](../src/components/graph/layout.ts) and [layout.test.ts](../src/components/graph/layout.test.ts), [CommitNode.tsx](../src/components/graph/CommitNode.tsx), [BranchLine.tsx](../src/components/graph/BranchLine.tsx), [BranchCommitDropdown.tsx](../src/components/panels/BranchCommitDropdown.tsx), [worktree-ui.ts](../src/store/worktree-ui.ts) (`BranchFilterPreset`).

## Mutations

[use-git-mutations.ts](../src/queries/use-git-mutations.ts) wraps each POST route in a TanStack mutation that targets the active worktree (`getActiveWt()`, except `useRevertToHeadMutation`, which takes an explicit worktree) and invalidates the affected queries on success. The WebSocket events above would refresh the same data; the invalidations make the acting window update without waiting for the watcher.

| Hook                                                                                    | Used by                                                                                                                                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useCheckoutMutation`, `useResetMutation`, `useCherryPickMutation`, `useRevertMutation` | commit and branch context menus ([CommitMenu.tsx](../src/components/menus/CommitMenu.tsx), [BranchMenu.tsx](../src/components/menus/BranchMenu.tsx)) |
| `useCreateBranchMutation`, `useDeleteBranchMutation`, `useRenameBranchMutation`         | branch panel, graph header, context menus                                                                                                            |
| `useRevertToHeadMutation`                                                               | Changes panel discard                                                                                                                                |
| `useDiscardChangesMutation`                                                             | [ProjectFilesPanel.tsx](../src/components/panels/ProjectFilesPanel.tsx)                                                                              |

There is no staging or commit UI.

## Invariants

- **Read paths never write under the Git directory.** Use `readOnlyGitEnv()` for every read-only command and never add `-c core.fsmonitor`; see the checklist in [WATCHERS.md](WATCHERS.md#review-checklist).
- **Do not run Git in a worktree being removed.** The remove route suspends the worktree's watchers first; while suspended, `requestStatusRefresh`, `publishWorktreeStatus` and `liveWorktreeStatus` in [server.ts](../src/server/server.ts) skip it, so no status pass runs there. Tracker sweeps skip it as well. Removal itself is covered in [WATCHERS.md](WATCHERS.md#worktree-lifecycle) and [PROJECTS_AND_WORKTREES.md](PROJECTS_AND_WORKTREES.md).
- **`index.lock`.** One server runs every Git command, so windows do not contend with each other ([SHARED_SERVER.md](SHARED_SERVER.md)). Reads take no optional locks. A mutation racing another Git process (a terminal or an agent) can fail on `index.lock`; the route returns the error as a 500.
- **Error messages.** A failed Git command's error includes Git's stderr, so the client can show why it failed.
- **Project cwd versus worktree.** Anything that depends on `HEAD` or the working tree runs in the active worktree, not in `project.cwd`: `getBranchCommits`, `getStatus`, working-tree diffs, the graph's `HEAD` marker, and every mutation, including cherry-pick and revert. In a linked worktree `HEAD` names a different commit than in the root checkout, and a bare project's `cwd` has no working tree.
- **Merge commits.** A single merge commit is diffed against its first parent, matching its `baseRef`.
- **Refs cache.** `getRefs` keeps one module-level entry (keyed by cwd) for 2 s to absorb bursts of reads; a refs change must invalidate it.
- **Submodules at the gitlink level.** Status, `revertToHead`'s classification, and unstaged and working-tree diffs run with `-c diff.ignoreSubmodules=dirty` (`SUBMODULE_GITLINK_ONLY`): a submodule appears only when its checked-out commit differs from the recorded one, never for edits inside it. It is a config default rather than `--ignore-submodules`, so per-submodule `submodule.<name>.ignore` still wins. This is a design decision (4 s versus 0.3 s for a status in a repository with 76 submodules).
- **Large repositories.** Status sweeps are capped at six concurrent processes; the untracked diff uses one `git diff` instead of one process per file; the graph is capped at 200 commits and the branch list at 100; diffs of commits and ranges are never refetched. `getBranches` and `getRecentBranchNames` run one `git reflog` per local branch, so their cost grows with branch count.

## Tests

Command tests in `src/server/git-commands/*.test.ts` run real Git against temporary repositories created by [test-utils.ts](../src/server/git-commands/test-utils.ts), which refuses to operate outside its own temp prefix. Parser tests cover status, diff and log output. Graph layout has unit tests in [layout.test.ts](../src/components/graph/layout.test.ts).
