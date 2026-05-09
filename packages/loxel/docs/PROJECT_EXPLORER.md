# Project Explorer Behavior

The Project Explorer is implemented by `ProjectFilesPanel`. It uses `FilesTree` for project files
and renders separate sections for detached draft files and external files.

## Path Model

Project file paths are absolute. The worktree root row has:

```ts
{ path: activeWorktreePath, name: basename(activeWorktreePath), isDir: true }
```

The empty string is not used as the project root identity.

Absolute paths are used because project file APIs, file lifecycle events, WebSocket directory change
events, and reveal events already use absolute paths. Context menu actions, drag and drop, paste,
new file/new directory, rename, delete, restore, reload, and selection all target the same absolute
path identity.

Detached draft paths remain outside the worktree. When a detached file is moved or copied into the
project, absolute destination directories under the worktree are normalized to safe relative paths on
the server before calling `DetachedFilesService`. Absolute destinations outside the worktree are
rejected.

## Root Row

The worktree root row is always rendered as its own row. `ProjectFilesPanel` passes
`compactRoot={false}` to `FilesTree`.

The root starts expanded when the panel mounts for an active worktree, but the user can collapse it.
Root expansion is initialized once per active worktree while the panel instance is mounted; it is not
continuously enforced. This prevents the mount effect from immediately re-opening a root the user
collapsed.

Root-specific behavior:

- Context menu root actions target `activeWorktreePath`.
- Rename, delete, cut, copy, and restore are disabled for the root.
- Paste into root targets `activeWorktreePath`.
- Dropping a project file already in the root onto the root is a no-op.

## Expansion State

Project Explorer expansion is controlled by the per-worktree UI store:

- `expandedProjectFolders`
- `setExpandedProjectFolders`
- `toggleProjectFolder`

Paths in `expandedProjectFolders` are absolute directory paths.

The expansion state is scoped per worktree through `worktree-ui`, so switching worktrees preserves
each worktree's expanded folders independently.

When a project path is renamed or moved, `renameProjectPaths(oldPrefix, newPrefix)` remaps expanded
folder paths and selected project file paths.

When a directory is collapsed, `ProjectFilesPanel`:

- clears cached tree children for that subtree
- calls `unwatchDir(activeWorktreePath, path)`
- removes React Query directory-cache entries for the collapsed subtree

Collapsed directory paths remain recorded inside `FilesTree` as user-collapsed paths so lazy
single-child auto-expansion does not re-open them after a later reload.

## Loading And Caching

`loadSubtree(path)` treats `path` as an absolute directory path, normalizes it with
`toAbsoluteDir(path, activeWorktreePath)`, and fetches:

```ts
queryKeys.dirContents(activeProjectPath, absDir);
```

The returned `DirEntry.path` values are already absolute and become `TreeNode.path` values.

Directory invalidation helpers accept either relative or absolute directory paths and normalize them
to the absolute query key before invalidating or removing queries.

## Directory Change Events

`loxel-dir-changed` events provide absolute directory paths. The Project Explorer passes the event
directory directly to `treeRef.current.reloadSubtree(dir)`.

For root updates, the event path is `activeWorktreePath`, matching the root row path and the cache
entry used by rendering.

## Reveal In Explorer

There are two reveal entry points:

- explicit command: dispatches `loxel-reveal-in-explorer`
- auto reveal: reacts to active editor tab changes when the `autoRevealInExplorer` setting is enabled

Both paths call the same `revealFileInTree(filePath)` helper.

For project files under the active worktree, reveal prefetches every ancestor directory using
absolute paths:

```text
/repo
/repo/src
/repo/src/components
```

Then it stores the selected project file and awaits `FilesTree.revealPath(filePath)`.

Expected reveal behavior:

- unloaded lazy ancestor subtrees are loaded
- all relevant ancestor folders are expanded
- the target file row is selected
- the target row receives DOM focus
- the target row scrolls into view

Auto reveal subscribes to the center Dockview API through `subscribeCenterApi()`. This handles the
case where `ProjectFilesPanel` mounts before the center API exists. When auto reveal is enabled and
the center API becomes available, the currently active editor is revealed immediately. Later active
tab changes are handled through `centerApi.onDidActivePanelChange`.

Only file-backed center panels are revealable:

- `editor`
- `codeEditor`
- `excalidraw`
- `media`

The file path is extracted from the active panel ID by matching the panel definition's `idPrefix`.

## Drag And Drop

Project file rows use `useProjectFileDrag`.

Row-level drop handlers always stop drag auto-scroll. The scroll container handles drag-over on the
capture phase so row `stopPropagation()` does not suppress edge scrolling.

Drops target canonical row paths:

- file rows target their parent directory
- directory rows target the directory itself
- root row targets `activeWorktreePath`

Detached drafts can be dropped into project directories to move them into the worktree.

## Selection And Keyboard

`selectedProjectFile` is stored in `worktree-ui` and uses absolute paths for project files.

Focus inside the Project Explorer updates `selectedProjectFile` and closes any open project file
context menu.

When the Project Explorer opens for an active worktree, focus defaults to the worktree root row.

Focus and selection are not the active/opened visual state. Keyboard focus, mouse hover, and rows
focused by arrow navigation use the hover background. The stronger active background is only applied
to the file path currently opened in the active center editor panel.

Project Explorer owns panel-level keyboard shortcuts and passes `disableBuiltinKeyNav` to
`FilesTree`. It still resolves tree keyboard input through the shared keybinding store, so these
behaviors are configurable through settings and the command palette.

Keyboard behavior:

- `tree.focusNext`, `tree.focusPrevious`, `tree.expandOrFocusChild`,
  `tree.collapseOrFocusParent`, and `tree.toggleExpanded` drive focus and expansion from the same
  row attributes as `FilesTree`
- `tree.open` opens focused files and toggles focused directories; default `Enter`
- `tree.rename` starts inline rename for non-root focused rows; defaults `F2` and `Shift+F6`
- canceling inline rename restores focus to the renamed row
- cut/copy/delete are disabled for the root
- paste into root targets `activeWorktreePath`

## Tests

Behavior coverage lives in `src/components/panels/ProjectFilesPanel.vitest.tsx` and
`src/server/routes.detached.test.ts`.

Important cases:

- root is visible and expanded on mount
- root receives default focus on mount
- root can be collapsed and stays collapsed
- root context menu targets the absolute worktree root
- root `loxel-dir-changed` refreshes rendered root children
- reveal-in-explorer loads lazy ancestors, focuses, and scrolls
- auto reveal works when the center API appears after mount and on later tab switches
- `tree.open` opens focused files and `tree.rename` starts inline rename
- canceling inline rename restores row focus
- row drops stop drag auto-scroll
- detached copy/move accepts relative destinations
- detached copy/move accepts absolute destinations inside the worktree
- detached copy/move rejects absolute destinations outside the worktree
