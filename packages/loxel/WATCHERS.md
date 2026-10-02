# Loxel filesystem watchers

Loxel keeps project files, Git status, refs, logs, worktrees, detached drafts, and external files
live through several independent watchers. This document records their ownership and the safety
constraints that matter when changing them.

## Watcher inventory

| Watcher                    | Owner               | Scope                               | Consumer                                               |
| -------------------------- | ------------------- | ----------------------------------- | ------------------------------------------------------ |
| Project `FileWatcher`      | `initializeProject` | Git directory/common directory      | refs, log, worktree lifecycle, and regular-repo status |
| Per-worktree `FileWatcher` | `subscribeWorktree` | linked-worktree Git admin directory | status only                                            |
| `ProjectFilesService`      | worktree resources  | working tree, recursive             | file tree and status overlays                          |
| `DetachedFilesService`     | worktree resources  | detached draft directory            | detached-file panels                                   |
| `ExternalFilesService`     | worktree resources  | individually opened external files  | external-file panels                                   |
| Git fsmonitor              | Git (user config)   | one daemon per Git directory        | Git status acceleration, only if the user enables it   |
| Language servers           | LSP managers        | implementation-specific             | diagnostics and language features                      |

For a bare project, the project Git directory is also the repository root and therefore contains
`.worktrees`. Classification must stay allowlist-based and anchored at the beginning of the
reported path; a catch-all would treat source edits and dependency writes as Git metadata.

## Git-directory events

`FileWatcher.classifyGitChange` maps paths onto `status`, `refs`, `log`, and `worktrees` refreshes.
Trailing `.lock` is stripped rather than ignored because macOS FSEvents may report only Git's
temporary lock filename. Read-only Git commands run by Loxel must set `GIT_OPTIONAL_LOCKS=0`, or a
status refresh can write `index.lock`, trigger another status refresh, and feed itself.

Nothing Loxel runs to read state may write under the Git directory, `objects/` included: loose objects map to a status/refs/log refresh. The untracked half of the working-tree diff therefore records intent-to-add entries in a throwaway index _and_ object directory — against the real object store, `git add -N` stores or freshens the empty blob, which would refetch the diff forever. The one known exception is porcelain `git diff`, which rewrites the index for stat-dirty entries (same content, new mtime) even under `GIT_OPTIONAL_LOCKS=0`; that write makes the entries fresh, so it costs one extra refresh and converges.

Important classifications:

| Path                                                    | Refreshes             |
| ------------------------------------------------------- | --------------------- |
| `index` / `index.lock`                                  | status                |
| root `HEAD`, branch/tag refs and reflogs                | refs and log          |
| root operation heads such as `MERGE_HEAD`               | status and refs       |
| loose objects                                           | status, refs, and log |
| `worktrees/<name>/gitdir` or `commondir`                | worktree lifecycle    |
| per-worktree metadata seen through the common directory | none                  |
| `.worktrees/<name>/...` source paths in a bare repo     | none                  |

The project watcher owns project-scoped events. A per-worktree watcher accepts only `status`; it
must not recursively watch the common directory once per worktree for events the project watcher
already handles.

Worktree add/remove also has a non-recursive watch on `<commonDir>/worktrees`. Removal of a watched directory does not reliably emit an event from that directory's own watcher, while its parent does observe the directory entry disappearing.

That watch emits only when the directory's modification time moved (an entry was added, removed or renamed) or the directory is gone. Bun (1.4.2) delivers a same-process recursive watch's churn to it as changes to `worktrees` itself, and in a bare repo the recursive watch covers every working tree: deleting a checkout with installed dependencies produced dozens of spurious lifecycle events, each broadcasting `worktrees_changed` and starting a cross-worktree status sweep. Comparing the mtime filters them without depending on how Bun routes events (see #311 for the other watchers it affects).

## Status refresh pipeline

A subscribed worktree's `ProjectFilesService` is the single reader of its Git status. Each refresh pass runs one `git status --porcelain=v2 --branch -z` plus one ignored-files listing, and the result feeds everything: the `status_changed` broadcast, the file-tree colors, and that worktree's entry in the cross-worktree dirty list. Working-tree edits (via `FilesSyncService`) and Git-directory events (via the `FileWatcher`s) both request passes; neither runs `git status` itself.

Passes are coalesced per worktree: one runs at a time, and everything requested meanwhile — flush batches with their nonces, file operations, Git-directory refreshes — merges into a single follow-up pass. A burst costs at most two passes, and no request is dropped, so the last event always produces a status that reflects it. There is no suppression window: the old 700ms one only existed to break a loop caused by forced fsmonitor index writes, and it silently dropped real updates that arrived inside it.

`WorktreeStatusTracker` owns each project's cross-worktree dirty list (`worktree_status_changed` and `/api/worktree-statuses`). Subscribed worktrees update their entry from their live snapshot at no Git cost. Unwatched worktrees can only be refreshed by a sweep that runs `git status` in each of them (at most six concurrently): soon after a `log` or `worktrees` event, and, when triggered only by activity in a subscribed worktree, no sooner than five seconds after the previous sweep finished. Sweeps are single-flight, reuse live snapshots, and keep a worktree's last known state when its status cannot be read rather than reporting it clean. An explicit request (a client loading the list) re-reads unless a sweep finished within the last two seconds, since unwatched worktrees change without any event. Clients rely on the pushed list and do not refetch it on `log_changed`.

The client refetches only working-tree diffs (staged, unstaged, uncommitted) on `status_changed` and ref/log events; commit and range diffs are keyed by full SHAs and never change. Full file contents are not refetched on `status_changed`: each `file_content_changed` invalidates that file's content queries, both an open editor's (keyed by absolute path) and the working-tree side of the side-by-side diff (keyed by worktree-relative path), whether or not the file is open in an editor.

## Working-tree file events

`FilesSyncService` owns the common `fs.watch`, debounce, individual-file watchers, and write nonce
tracking used by the three file services.

- A named event is filtered, normalized, and batched.
- A null-filename event requests a conservative cache refresh.
- Write nonces annotate the resulting event so the originating editor can suppress its echo.
- `pause()` closes active watch handles but deliberately keeps caches, tracked files, queued
  changes, and nonce state. It waits for an in-flight flush to finish before removal starts.
  `resume()` recreates those handles, requests a conservative directory rescan, and emits a
  catch-up notification for every individually watched file because `fs.watch` cannot replay the
  paused interval. `stop()` is permanent teardown and clears state.

The pause/stop distinction is important during worktree removal. A failed removal must resume the
same service state; calling `stop()` would erase `ProjectFilesService` caches,
`DetachedFilesService` entries, and `ExternalFilesService`'s tracked-file set.

## Worktree lifecycle

On a `worktrees` event the server broadcasts `worktrees_changed` before reconciling deleted
resource entries. `broadcastToProject` discovers recipients through those entries, so reversing
the order can prevent the client that had the deleted worktree open from hearing the update.

Reconciliation then:

1. finds resources for the exact project whose worktree path no longer exists;
2. removes the path from each subscriber's subscription set;
3. tears down its Git/file/detached/external watchers and related caches.

Before an in-app removal, filesystem delivery for that worktree is paused. `wt` renames the checkout into `<worktreesDir>/.wt-trash/` and returns once git has unregistered it; the files are deleted afterwards by a detached `rm -rf`, so the route answers in well under a second rather than after the many seconds the deletion takes. Those deletions happen outside any subscribed working tree: in a bare repo the project watcher sees them under `.worktrees/` and classifies them as nothing, and a regular repository's root checkout ignores `.worktrees/` through `info/exclude`. If Git refuses removal, every service is
given a chance to resume without losing state, and a failure in one does not prevent the others.
If removal succeeds, the route sends the final project broadcast and immediately performs
permanent teardown; a later lifecycle event is harmless and keeps external removals covered.
If removal fails, the server also asks the client to refetch worktree-scoped file queries; dirty
editors use the normal conflict-aware disk-change path rather than silently accepting new content.

The client validates its active path after every worktree-list refresh, not only during hydration.
If an externally removed linked worktree was active, it purges worktree-scoped stores, unsubscribes
the dead path, and switches to a surviving worktree. A regular repository falls back to its root
checkout; a bare repository falls back to its first remaining worktree or no active path.
Project ownership must use explicit worktree membership or path-boundary-aware matching—never a
raw prefix such as `/repo`, which also matches `/repo-other`.

## Performance notes

Mass deletion is usually coalesced into relatively few FSEvents events. The expensive part is the
consumer: each event can make `ProjectFilesService` rebuild Git status and reread cached
directories while the tree is disappearing. Suspension targets that cost.

`objects/` intentionally over-fires status, refs, and log refreshes because FSEvents can omit the
more specific ref/index names during a commit. Per-event debouncing bounds the extra reads.

## External processes

Loxel never passes `-c core.fsmonitor=true`; whether Git's fsmonitor daemon runs is the user's Git configuration to decide. Loxel used to force it on, which left a persistent daemon behind for every Git directory a status touched — every worktree and, because `-c` settings travel to child Git processes, every submodule — and bought nothing: with `GIT_OPTIONAL_LOCKS=0` Git can never save the fsmonitor token in the index, so every query got a "trivial" answer followed by a full scan. Daemons started by those versions stay until their worktree is removed; stopping them is safe (`pkill -f 'git fsmonitor--daemon'`), since Git restarts one on demand where config enables it.

Status and working-tree diffs run with `-c diff.ignoreSubmodules=dirty` (`SUBMODULE_GITLINK_ONLY` in `git-env.ts`): a submodule is reported only when its checked-out commit differs from the recorded one, never for edits or untracked files inside it. Otherwise Git runs a status inside every submodule, recursively, on every refresh — 4s instead of 0.3s in a repository with 76 submodules. This is a deliberate design decision. It is a default, so a repository's own `submodule.<name>.ignore` still wins: an `ignore=all` submodule stays hidden, and one set to `none` is still inspected in full.

When the user does enable fsmonitor, daemon count scales with Git directories, not just top-level worktrees. Git reuses one daemon via `<gitdir>/fsmonitor--daemon.ipc`; a high count alone is not evidence of a leak.

Language servers may run their own watchers. They are not currently torn down when a worktree is
removed, so they can remain rooted at a deleted path. That lifecycle gap is outside this change
and should be considered when consolidating watcher ownership.

## Review checklist

When changing watcher behavior, verify:

- read-only Git calls use `readOnlyGitEnv()` and never pass `-c core.fsmonitor`;
- nothing a read path runs writes under the Git directory, `objects/` included;
- watcher-driven status consumers use the files-service snapshot instead of running another `git status` (an explicit `/api/status` request still reads fresh, so it reflects a just-finished mutation);
- a burst of events is coalesced, never dropped: the last event is always reflected;
- bare-repo source paths cannot match Git metadata rules;
- project-level events are not multiplied once per subscribed worktree;
- worktree lifecycle broadcasts precede resource teardown;
- temporary suspension preserves caches, tracked paths, pending changes, and nonces;
- restarting a stopped `FileWatcher` restores Git event delivery without duplicate handles;
- permanent teardown closes every watch handle and clears timers;
- regular-repository root checkouts remain valid active paths;
- similarly prefixed and external-`WT_DIR` projects are not confused;
- deleted paths are treated as expected lifecycle races while other failures retain useful error
  context.

Native watcher behavior is platform-specific. The lifecycle and feedback-loop integration tests
need real macOS FSEvents access and cannot be meaningfully validated inside a restricted
filesystem sandbox.
