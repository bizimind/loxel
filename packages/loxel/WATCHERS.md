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
| Git fsmonitor              | Git                 | one daemon per Git directory        | Git status acceleration                                |
| Language servers           | LSP managers        | implementation-specific             | diagnostics and language features                      |

For a bare project, the project Git directory is also the repository root and therefore contains
`.worktrees`. Classification must stay allowlist-based and anchored at the beginning of the
reported path; a catch-all would treat source edits and dependency writes as Git metadata.

## Git-directory events

`FileWatcher.classifyGitChange` maps paths onto `status`, `refs`, `log`, and `worktrees` refreshes.
Trailing `.lock` is stripped rather than ignored because macOS FSEvents may report only Git's
temporary lock filename. Read-only Git commands run by Loxel must set `GIT_OPTIONAL_LOCKS=0`, or a
status refresh can write `index.lock`, trigger another status refresh, and feed itself.

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

Worktree add/remove also has a non-recursive watch on `<commonDir>/worktrees`. Removal of a watched
directory does not reliably emit an event from that directory's own watcher, while its parent does
observe the directory entry disappearing.

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

Before an in-app removal, filesystem delivery for that worktree is paused. This avoids expensive
cache refreshes while thousands of files disappear. If Git refuses removal, every service is
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

Git fsmonitor daemon count scales with Git directories, not just top-level worktrees. Submodules
are separate repositories and can account for most daemon processes. Git reuses one daemon via
`<gitdir>/fsmonitor--daemon.ipc`; a high count alone is not evidence of a leak. Measurements that
motivated this document found matching live Git directories and no orphaned daemon roots.

Language servers may run their own watchers. They are not currently torn down when a worktree is
removed, so they can remain rooted at a deleted path. That lifecycle gap is outside this change
and should be considered when consolidating watcher ownership.

## Review checklist

When changing watcher behavior, verify:

- read-only Git calls use `readOnlyGitEnv()`;
- bare-repo source paths cannot match Git metadata rules;
- project-level events are not multiplied once per subscribed worktree;
- worktree lifecycle broadcasts precede resource teardown;
- temporary suspension preserves caches, tracked paths, pending changes, and nonces;
- permanent teardown closes every watch handle and clears timers;
- regular-repository root checkouts remain valid active paths;
- similarly prefixed and external-`WT_DIR` projects are not confused;
- deleted paths are treated as expected lifecycle races while other failures retain useful error
  context.

Native watcher behavior is platform-specific. The lifecycle and feedback-loop integration tests
need real macOS FSEvents access and cannot be meaningfully validated inside a restricted
filesystem sandbox.
