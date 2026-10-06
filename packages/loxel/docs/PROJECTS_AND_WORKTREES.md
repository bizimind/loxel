# Projects, worktrees and context switching

How Loxel models registered repositories (projects) and their worktrees on the server and in the renderer, how projects are created and initialized, how the active worktree changes, and how non-project folders (Others) fit in.

Related internal docs: [ARCHITECTURE.md](ARCHITECTURE.md) for the process overview, [SHARED_SERVER.md](SHARED_SERVER.md) for server ownership and persistent state, [WATCHERS.md](WATCHERS.md) for watcher ownership and the worktree removal lifecycle, [STATE_AND_STORAGE.md](STATE_AND_STORAGE.md) for client store persistence, [GIT.md](GIT.md) for git commands and worktree status. The `wt` tool itself is documented in [packages/wt/README.md](../../wt/README.md).

## Vocabulary

- **Project**: a registered git repository, regular or bare. Identified on disk by its git root (`getGitRoot`: `rev-parse --show-toplevel`, or `--git-common-dir` for a bare repo).
- **Worktree**: a `wt`-managed linked worktree of a project, listed with `listManagedWorktrees` from `@bizimind/wt/lib`. A regular repo's root checkout is also a valid "worktree" context in the renderer; a bare repo's root is not (the server refuses to subscribe to it).
- **Active worktree**: the absolute path the renderer is working in. Everything worktree-scoped (layout, per-worktree stores, WebSocket subscription, language servers) is keyed by it.
- **Others**: folders and files outside every project, opened in a worktree's Others section. No git, no `wt`.

## Project model

[project-model.ts](../src/api/project-model.ts) defines `ProjectSchema` (`id`, `path`, `name`, `addedAt`, `isBare`) and `EnrichedProject`, which `GET /api/projects` returns with inline `worktrees` and `worktreesDir` (null when the server has not initialized the project). It also holds the Add Project wizard request/response types.

[project-store.ts](../src/server/project-store.ts) persists projects in `<stateDir>/projects.db` (see [STATE_AND_STORAGE.md](STATE_AND_STORAGE.md#server-state-directory) for the state directory and the one-time `projects.json` migration):

- Table `projects(id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL, added_at TEXT NOT NULL)`.
- `id` is a random UUID; `path` is the uniqueness key. `addProject` resolves the git root first, then does `INSERT OR IGNORE` and re-selects by path, so concurrent adds of the same repo from two processes converge on one row, and re-adding an existing path returns the original id (convert-to-bare relies on this: the path is unchanged, so the id survives).
- `isBare` is not stored; it is recomputed with `isBareRepo` on every `loadProjects`/`addProject`/`updateProject`. Unreachable paths default to `false`.
- Only `name` is mutable (`PATCH /api/projects/:id`).
- `loadProjects` has no `ORDER BY`; there is no project ordering or hidden state. Ordering and hiding exist only for worktrees (see Sidebar below).

Derived per-repo state is keyed by a hash of the git root (`hash12` in [config.ts](../src/server/config.ts)): the local database at `localdb/<hash>/localdb.db`, and drafts at `detached/<projectHash>/<worktreeHash>/`. Review comments are in `comments/<hash>.db` ([review-db.ts](../src/server/review-db.ts)). Moving a repo on disk therefore orphans these.

[projects.ts](../src/store/projects.ts) is the renderer's project store. `fetchProjects` loads enriched projects and hands them to the worktree store (`applyEnrichedProjects`); `whenProjectsLoaded()` resolves after the first fetch settles (even on failure) so open requests that arrive during launch can wait for it. `deriveProject(wtPath, projects)` finds the owning project by explicit worktree membership first, then by boundary-aware prefix (`path + "/"`), longest path winning. Removing or deleting the active project switches to the first remaining project (its root if regular, its first worktree if bare) or resets the worktree store. The store also persists sidebar width/expanded state and per-project expansion through server storage.

## Server-side project lifecycle

[server.ts](../src/server/server.ts) holds two maps: `projects` (`ProjectState`, keyed by git root, always running) and `wtResources` (`WorktreeResources`, keyed by worktree path, alive while subscribed). Both shapes live in [server-state.ts](../src/server/server-state.ts). There is no server-side "active project" or "active worktree"; the server serves all projects concurrently.

At startup the server loads `projects.db`, registers `process.argv[2]` as a project if given, then runs `initializeProject` for every project in parallel (`Promise.allSettled`, failures are logged and the project stays without server state). `initializeProject(repoPath)`:

1. resolves the git root and bare-ness;
2. creates the project-level `FileWatcher` (bare repos only allow `refs`, `log`, `worktrees` events; see [WATCHERS.md](WATCHERS.md));
3. in parallel: prunes orphaned internal temp worktrees (directory basename starts with `INTERNAL_WORKTREE_PREFIX` from [worktree-utils.ts](../src/server/worktree-utils.ts); force-removed with `git worktree remove`), opens the `ReviewDb`, reads the git author name, starts the watcher, resolves `worktreesDir` and lists managed worktrees;
4. opens the project's local database and creates its `WorktreeStatusTracker`;
5. stores the `ProjectState`. Worktree-level services are not created here.

`teardownProject` tears down every `WorktreeResources` of the project, stops the watcher and status tracker and closes both databases.

Worktree resources (status watcher for linked worktrees, files service, drafts, external files, Others folders, file-operation history) are created by `subscribeWorktree` on the first `subscribe_worktree` WebSocket message and torn down when the last subscriber leaves. Removal-specific teardown (`suspendWorktreeWatchers`, `completeWorktreeRemoval`, `reconcileRemovedWorktrees`) is described in [WATCHERS.md](WATCHERS.md#worktree-lifecycle).

The project watcher's `worktrees` event broadcasts `worktrees_changed` to the project's subscribers, then releases resources of worktrees whose directory is gone, then invalidates the status tracker.

## Project setup flows

All routes are in [routes.ts](../src/server/routes.ts) and are driven by [AddProjectWizard.tsx](../src/components/projects/AddProjectWizard.tsx) (opened from [EmptyState.tsx](../src/components/EmptyState.tsx), or from the sidebar outside Electron). In Electron the sidebar's add button uses the native folder dialog and calls `useProjectStore.addProject` directly.

| Route                                | Purpose                                                                                                                                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/browse`                    | Child directories for [FolderPicker.tsx](../src/components/projects/FolderPicker.tsx), flagged `isGitRepo` by a `.git` or `HEAD`+`objects` heuristic.                                                                                                          |
| `POST /api/projects/detect`          | Classify a path with `detectRepoType`: bare, regular/worktree (normalized to its git root, with branch and dirty flag), non-repo folder, not found. Git URLs are detected client-side ([wizard-detection.ts](../src/components/projects/wizard-detection.ts)). |
| `GET /api/projects/scan-suggestions` | Suggest files to copy and setup commands from lockfiles, `.env*`, `.envrc`, mise files (`SUGGESTION_RULES`).                                                                                                                                                   |
| `POST /api/projects`                 | Add as-is.                                                                                                                                                                                                                                                     |
| `POST /api/projects/create`          | New directory: `git init` (single) or bare repo + empty initial commit + `.worktrees` + hook + `main` worktree (multi).                                                                                                                                        |
| `POST /api/projects/clone`           | `git clone` (single) or `git clone --bare` into `<name>.git`, then hook and a worktree for the default branch read from `HEAD` (multi).                                                                                                                        |
| `POST /api/projects/init`            | Existing non-repo folder. Multi with files: `git init`, commit everything, `transformToBare`; multi without files: bare init + empty commit. Then hook and a `main` worktree if missing.                                                                       |
| `POST /api/projects/convert`         | Convert a regular repo to bare + `wt` layout.                                                                                                                                                                                                                  |

`setup: "multi"` is the multi-workspace mode. `writeInitHook` writes a repo-root `init.wt.sh` that copies each `copyFiles` entry from `$WT_ROOT/.wt-local-res/` (seeding empty placeholders there) and then runs the setup commands; it is a no-op when both lists are empty. `validateCopyFiles` rejects absolute paths, empty segments, `.` and `..`, and runs before any filesystem mutation.

Convert preconditions, all checked before the live project is torn down: the path is a regular repo, has no uncommitted changes, HEAD is not detached, and `assertCanTransformToBare` passes (it rejects existing linked worktrees and an existing destination, per [routes.project-setup.test.ts](../src/server/routes.project-setup.test.ts)). Only then is `teardownProject` called; if `transformToBare` or the hook write fails, the project is re-initialized in its old form.

Every flow ends the same way: `projectStore.addProject`, then `initializeProject`, removing the row again if initialization throws, then `broadcastAll(worktrees_changed)`. Project add and delete broadcast to all clients because a new project has no subscribers yet and a deleted one has none left.

What shells out where: plain `git` is spawned directly for `init`, `clone`, `add`/`commit` during init, and the initial empty commit. Repo-shape operations (`detectRepoType`, `initBareRepo`, `transformToBare`, `ensureWorktreesDir`, `executeAdd`) come from `@bizimind/wt/lib`, imported in-process, not by spawning the `wt` binary.

`DELETE /api/projects/:id` unregisters (teardown + row delete). `POST /api/projects/:id/delete` additionally `rm -rf`s the project path.

## Worktree operations and `wt`

Loxel never runs the `wt` CLI; it calls the `@bizimind/wt/lib` API (`planAdd`/`executeAdd`, `planRemove`/`executeRemove`, `getWorktreeName`, `listManagedWorktrees`). Hooks (`init.wt.sh`, `clean.wt.sh`) are run by that library; Loxel passes `hookEnv: buildSpawnEnv()` from [shell-env.ts](../src/server/shell-env.ts), which is the server environment with `PATH` replaced by the login shell's `PATH` (when it could be resolved) and `~/.local/bin` prepended if missing. Progress messages go to the `worktrees` log category. Worktree rename is not exposed by Loxel (no `move` API is imported).

- `GET /api/projects/:id/worktrees` and `GET /api/projects` list worktrees via `listProjectWorktrees`: managed worktrees minus internal temp ones, `createdAt` from the directory's birth time, `isMain: false`.
- `POST /api/worktree/plan-add` returns the target path and any branch conflict. `POST /api/worktree/create` runs `executeAdd` with an optional `branch` and `branchResolution` (`use-existing` or `delete-and-create`), then broadcasts `worktrees_changed` to the project.
- `POST /api/worktree/plan-remove` and `/remove` take the worktree path, not the name. Removal suspends the worktree's watchers, runs `executeRemove` with `expectedPath`, and on success broadcasts `worktrees_changed`, completes teardown and deletes the worktree's persisted Others list; on failure it resumes the watchers. `deleteBranch` also sets `forceBranch`, by design (see the comment in `handleRemoveWorktree`). The fast trash-then-delete behavior belongs to `wt` and is described in [WATCHERS.md](WATCHERS.md#worktree-lifecycle).

## Renderer worktree model

[worktrees.ts](../src/store/worktrees.ts) (`useWorktreeStore`) holds `byProject` (per project path: `worktrees`, `worktreesDir`, `customOrder`, `hiddenPaths`), `activeWorktreePath`, and pending add/remove plans.

- **Applying server lists.** `applyEnrichedProjects` keeps a project's previous list when the server returns an empty one (an uninitialized project), prunes `customOrder`/`hiddenPaths` to existing paths, and validates the active path, falling back to the first project's root or first worktree. `refreshProjectWorktrees(projectPath)` runs on every `worktrees_changed` ([ws-bridge.ts](../src/queries/ws-bridge.ts)); a per-project request id discards out-of-order responses.
- **Optimistic add.** `createWorktree` plans first; a branch used by another worktree throws, any other conflict parks the plan in `pendingAddPlan` for the user. Otherwise an entry with `pending: "creating"` is inserted, removed again if the request fails.
- **Non-optimistic remove.** `confirmRemoveWorktree` marks the entry `pending: "removing"` and records the path in a module-level `removingPaths` set so refreshes that land mid-request keep the marker. After success it purges per-worktree stores and caches, unsubscribes, and refreshes.
- **Active worktree removed elsewhere.** After each refresh, if the active path belonged to the project and is gone, the store purges its state, unsubscribes it and falls back (regular repo: its root; bare: first remaining worktree or none).
- **Ordering.** `getOrderedWorktrees` sorts by `customOrder` when set, otherwise by `createdAt`; worktrees not in the custom order go last by `createdAt`.

[worktree-store.ts](../src/store/worktree-store.ts) is the factory for per-worktree Zustand instances (`createWorktreeStore`): a map of instances keyed by worktree path, a hook that selects the instance from `activeWorktreePath`, `getCurrent()` for imperative code via the module-level `activeWorktreeKey`, a no-op store (warns on writes) when nothing is active, and a registry so `purgeWorktreeStores(path)` drops every instance at once. Users: [worktree-repository.ts](../src/store/worktree-repository.ts) (commit selection, diff source), `worktree-ui.ts`, `worktree-reviews.ts`, `worktree-tools-bar.ts`. These instances are in memory only.

[worktree-cache.ts](../src/store/worktree-cache.ts) adds a generic `${worktree}::${key}` cache (used for inner dockview layouts) and `transitionWorktreeState`, which sets the active key and clears the comment store. [active-worktree.ts](../src/store/active-worktree.ts) exposes `getActiveWt()`, which throws when nothing is active. [worktree-history.ts](../src/store/worktree-history.ts) records back/forward stacks (see [KEYBINDINGS.md](KEYBINDINGS.md)).

`customOrder` and `hiddenPaths` are persisted through server storage (the `worktrees` store key). Cross-window updates of that slice and of the project store's sidebar state are applied by [store-sync.ts](../src/store/store-sync.ts) through [reconcile.ts](../src/lib/reconcile.ts), which keeps old references for deeply equal subtrees so selectors do not re-render. `reconcile` is not used for server worktree lists.

## Context switching

`switchWorktree(path)` is synchronous in effect: it sets `activeWorktreePath` and calls `transitionWorktreeState` before its first `await`, and makes no server call. Everything else reacts to the path:

1. **Layout.** [App.tsx](../src/App.tsx) renders the outer dockview with `layoutKey={activeWorktreePath}`, so each worktree has its own saved layout, stored per window under `layout:session:<windowId>:<scope>:<worktreePath>` ([layout-key-schema.ts](../src/lib/layout-key-schema.ts)). See [PANELS_AND_LAYOUT.md](PANELS_AND_LAYOUT.md).
2. **Per-worktree stores** resolve to the new instance through the factory hook; comment state is cleared.
3. **Server subscription.** [useWsSubscription.ts](../src/hooks/useWsSubscription.ts) subscribes to the new worktree immediately and unsubscribes the previous one only after its pending saves drain, so auto-saves during panel unmount still find live server resources. On reconnect it resubscribes and re-registers open external files.
4. **Queries** derive their scope (`activeProjectPath`, `activeWorktreePath`) from [use-scope.ts](../src/queries/use-scope.ts).
5. **Language servers.** [monaco-env.ts](../src/lib/monaco-env.ts) reconnects the TypeScript server for the new worktree and recounts models for the lazily connected ones. See [LANGUAGE_SERVERS.md](LANGUAGE_SERVERS.md).
6. **Terminals and agent sessions** are panels in the worktree's layout and capture their worktree when created (`usePanelWorktreePath`). Unmounting a terminal panel does not send `terminal_destroy`. See [TERMINALS.md](TERMINALS.md) and [CODING_AGENT_INTEGRATION.md](CODING_AGENT_INTEGRATION.md).

### Per-window state

Each window has its own active worktree: `activeWorktreePath` is mirrored to `sessionStorage`, not to server storage. Back/forward history is in memory per window. [window-id.ts](../src/lib/window-id.ts) provides `WINDOW_ID` (from the Electron preload, or a `localStorage` UUID in a plain browser; missing in Electron is a hard error) and `IS_FIRST_WINDOW` for layout restore. [useWindowPresence.ts](../src/hooks/useWindowPresence.ts) sends `window_hello` with the id and `window_focused` on focus (including Electron BrowserWindow focus that DOM focus misses). The server stores the id on the connection's `ClientState` and uses `sendToActiveWindow` to route `POST /api/open` requests to the window whose terminal ran `loxel <path>` (terminals get `LOXEL_WINDOW_ID`), else to the last focused window.

## Others (non-project folders)

[external-folders-service.ts](../src/server/external-folders-service.ts) has two parts:

- `ExternalFolderRegistry` (one per server) shares one `ProjectFilesService` (git status disabled) per folder root across every worktree that lists it, starting the watcher on first acquire and stopping it on last release.
- `ExternalFoldersService` (one per subscribed worktree) is that worktree's list of open folders, persisted in the store database under `external-folders:<worktreePath>`. Folders never nest: adding one inside an open folder returns the existing root, adding a parent replaces its children. File operations get a `FileOperationsService` with `git: false` sharing the worktree's undo history. On restore, missing or now-conflicting folders are dropped.

Differences from worktrees: no git, no `wt`, no project row; a folder is live only while a subscribed worktree lists it. `externalFolderConflict` in [server-state.ts](../src/server/server-state.ts) rejects `/`, the home directory, folders inside a project (cwd or `worktreesDir`) and folders containing a project. `POST /api/external-folders/add` canonicalizes with `realpath` and requires the worktree to have live resources (503 otherwise).

Entry points: `loxel <folder>` and Finder both reach `POST /api/open`, which sends `open_folder`/`open_file` to a window ([ELECTRON.md](ELECTRON.md), [TERMINALS.md](TERMINALS.md)). [open-path.ts](../src/lib/open-path.ts) then switches to the owning worktree when the path is inside one (`deriveOwningWorktree`), refuses paths inside a project but outside its worktrees, and otherwise adds the folder to the active worktree's Others. UI behavior is in [PROJECT_EXPLORER.md](PROJECT_EXPLORER.md).

## Sidebar

[Sidebar.tsx](../src/components/sidebar/Sidebar.tsx) reads `useProjectStore.projects` and `useWorktreeStore.byProject`. Clicking a bare project toggles expansion; clicking a regular project switches to its root. Projects auto-expand once (`autoExpandedProjectIds`). Worktree rows reorder with `@dnd-kit` and write `setCustomOrder`; hide/show writes `toggleVisibility`. The expanded sidebar shows all worktrees; the collapsed icon rail filters out `hiddenPaths`, so a reorder there saves only the visible paths. Context menus are local state in the sidebar (`useWorktreeContextMenu` for worktrees, a project menu for rename/remove/delete); removal goes through `requestRemoveWorktree` (plan) and `confirmRemoveWorktree`. Pending entries get no context menu. Icons: [ProjectIcon.tsx](../src/components/projects/ProjectIcon.tsx), [WorktreeIcon.tsx](../src/components/worktrees/WorktreeIcon.tsx). Layout and resizing: [PANELS_AND_LAYOUT.md](PANELS_AND_LAYOUT.md).

## Invariants

- **Absolute paths are identity.** Projects are keyed by git root, worktree resources and per-worktree client stores by absolute worktree path. Ownership checks must be boundary-aware (`isWithin`, `findTreeRoot` in [project-file-helpers.ts](../src/lib/project-file-helpers.ts)); a raw prefix `/repo` also matches `/repo-other`. `findOwningProject` also checks `worktreesDir`, because `WT_DIR` can place worktrees outside the repo.
- **Validate client-supplied paths.** What routes check today:
  - `?wt=`/`?project=` routes (`resolveWorktreeFromReq`, `resolveProjectFromReq`) and `subscribe_worktree` only require the path to be inside a registered project's cwd or `worktreesDir`; they do not check that it is a registered worktree. `subscribe_worktree` refuses a bare repo's root.
  - Worktree CRUD requires `projectPath` to be an exact key of the initialized projects map. Remove and plan-remove additionally check the path against `git worktree list` (`validateWorktreePath`) and pass it as `expectedPath`, so a same-basename worktree elsewhere cannot be removed ([routes.worktrees.test.ts](../src/server/routes.worktrees.test.ts)).
  - Others routes require live `WorktreeResources` for `wt`.
- **One server per repository.** Pruning temp worktrees on init and the in-memory removal bookkeeping assume a single server uses a repository at a time; see [SHARED_SERVER.md](SHARED_SERVER.md).

## Known inconsistencies

- `worktrees_changed` sent by project add/delete reaches every window, but `refreshProjectWorktrees` ignores projects missing from the local list and never refetches the project list. Other windows therefore do not show a newly added project until they call `fetchProjects` again. For a deleted project the refresh requests its worktrees by id, which the server no longer knows.
- Comments in [worktrees.ts](../src/store/worktrees.ts) say `customOrder`/`hiddenPaths` persist to localStorage; they go to server storage (localStorage is only a migration fallback in [server-storage.ts](../src/store/server-storage.ts)). The rollback comment in `handleAddProject` still mentions `projects.json`.
- `GET /api/projects/:id/worktrees` calls `loadProjects()`, which runs `isBareRepo` for every project, to resolve one id.
- The `worktrees` list returned by `initializeProject` has `createdAt: null` and is not used by any route.
