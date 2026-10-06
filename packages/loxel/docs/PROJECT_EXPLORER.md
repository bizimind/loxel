# Project Explorer Behavior

Behavior contract of the Project Explorer (the "Project Files" panel, `ProjectFilesPanel`): its path model, root and Others rows, expansion, loading, reveal, drag and drop, and keyboard handling.

## Layout

From top to bottom the panel shows:

- a header with the worktree path (with a copy button) and a button that reveals the active editor's file;
- a **Drafts** section listing detached draft files (`DetachedFileNode`), when there are any;
- one `FilesTree` (see [FILES_TREE.md](FILES_TREE.md)) whose roots are the active worktree, then each folder in the **Others** section, then each individually opened Others file. The Others heading is rendered with `renderRootHeader` above the first root after the worktree.

Others folders are browsed and edited like the worktree; individually opened Others files belong to no folder tree and are read-only in the tree. Others rows show their full path on hover.

## Path Model

Tree paths are absolute. The worktree root row is:

```ts
{ path: activeWorktreePath, name: basename(activeWorktreePath), isDir: true }
```

The empty string is not used as the project root identity.

Absolute paths are used because project file APIs, file lifecycle events, WebSocket directory change events, and reveal events already use absolute paths. Context menu actions, drag and drop, paste, new file/new directory, rename, delete, restore, reload, and selection all target the same absolute path identity.

`getTreeRoot(path)` returns the root of the tree that shows a path: the worktree or an Others folder, or null for an Others file. File operations stay within their tree.

Detached draft paths remain outside the worktree. When a detached file is moved or copied into the project, absolute destination directories under the worktree are normalized to safe relative paths on the server before calling `DetachedFilesService`. Absolute destinations outside the worktree are rejected.

## Root Rows

The worktree root is always rendered as its own row: `ProjectFilesPanel` passes `compactRoot={false}` to `FilesTree`.

The worktree root starts expanded the first time the panel instance shows a worktree, but the user can collapse it. Root expansion is initialized once per worktree while the panel instance is mounted; it is not continuously enforced, so the mount effect never re-opens a root the user collapsed. The root row also receives focus the first time the panel shows a worktree.

Tree roots (the worktree and Others folders) and Others files are fixed rows:

- Rename, delete, cut, copy, and drag are disabled for them.
- Paste on the worktree root targets `activeWorktreePath`.
- Right-clicking an Others folder root offers **Remove from Others**, which forgets its cached listing and expansion state like a collapse does.
- Git Restore is offered only for modified entries, never for a root or a draft.

## Expansion State

Project Explorer expansion is controlled by the per-worktree UI store (`src/store/worktree-ui.ts`): `expandedProjectFolders` / `setExpandedProjectFolders`. Paths in `expandedProjectFolders` are absolute directory paths. The state is scoped per worktree, so switching worktrees preserves each worktree's expanded folders independently.

When a project path is renamed or moved, `renameProjectPaths(oldPrefix, newPrefix)` remaps expanded folder paths and the selected project file path.

When a directory is collapsed, `ProjectFilesPanel`:

- clears cached tree children for that subtree
- calls `unwatchDir(activeWorktreePath, path)`
- removes React Query directory-cache entries for the collapsed subtree

Collapsed directory paths remain recorded inside `FilesTree` as user-collapsed paths so lazy single-child auto-expansion does not re-open them after a later reload.

## Loading And Caching

`loadSubtree(path)` treats `path` as an absolute directory path, normalizes it with `toAbsoluteDir(path, activeWorktreePath)`, and fetches:

```ts
queryKeys.dirContents(activeProjectPath, absDir);
```

The returned `DirEntry.path` values are already absolute and become `TreeNode.path` values.

Worktree directories are cached until a change event invalidates them. Others folder directories are re-read on every load, because a folder may have changed while no worktree listing it was active.

Directory invalidation helpers (`src/queries/query-helpers.ts`) accept either relative or absolute directory paths and normalize them to the absolute query key before invalidating or removing queries.

## Directory Change Events

`loxel-dir-changed` events provide absolute directory paths. The Project Explorer passes the event directory directly to `treeRef.current.reloadSubtree(dir)`.

For root updates, the event path is `activeWorktreePath`, matching the root row path and the cache entry used by rendering.

## Reveal In Explorer

There are four reveal entry points:

- reveal event: `loxel-reveal-in-explorer`, dispatched by Quick Open and search results, and by the `file.revealInExplorer` command (which also shows the panel), to select a file if the panel is mounted. Unlike the pending reveal it also reaches individually opened Others files
- auto reveal: reacts to active editor tab changes when the `autoRevealInExplorer` setting is enabled
- header button: reveals the active editor's file
- pending reveal: `pendingReveal` in the per-worktree UI store (`{ path, expand }`). `revealInProjectExplorer(path)` (`src/lib/reveal-in-explorer.ts`) shows the panel and sets it — used by the Changes panel's **Reveal in Project Explorer** — and `openFolder` sets it with `expand: true` (across a worktree switch, or before a new Others folder is listed). The panel retries it on directory changes until the tree can show the path, then clears it

All of them call the same `revealFileInTree(filePath)` helper.

For a path inside a tree root (the worktree or an Others folder), reveal first prefetches every ancestor directory from the root down using absolute paths:

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

Auto reveal subscribes to the center Dockview API through `subscribeCenterApi()`. This handles the case where `ProjectFilesPanel` mounts before the center API exists. When auto reveal is enabled and the center API becomes available, the currently active editor is revealed immediately. Later active tab changes are handled through `centerApi.onDidActivePanelChange`.

Only file-backed center panels are revealable:

- `editor`
- `codeEditor`
- `excalidraw`
- `media`

The file path is extracted from the active panel ID by matching the panel definition's `idPrefix` (`getActiveEditorFilePath`). The same path is passed to `FilesTree` as `activePath`.

## Drag And Drop

Project file rows use `useProjectFileDrag`.

Only entries inside a tree are draggable; roots and Others files are not. Drops stay within the dragged item's tree, and drafts can only be dropped into the worktree, which moves them into it.

Drops target canonical row paths:

- file rows target their parent directory
- directory rows target the directory itself
- the empty area below the rows targets `activeWorktreePath`

Dropping an item into its current parent directory, or a directory into itself or one of its descendants, is refused.

Row-level drop handlers always stop drag auto-scroll. The scroll container handles drag-over on the capture phase so row `stopPropagation()` does not suppress edge scrolling.

## Selection And Keyboard

`selectedProjectFile` is stored in `worktree-ui` and uses absolute paths.

Focus inside the Project Explorer updates `selectedProjectFile` and closes any open project file context menu.

Focus and selection are not the active/opened visual state. Clicking a row focuses it. The focused row (by click or keyboard) has a stronger tint and an outline than the light hover tint (see [FILES_TREE.md](FILES_TREE.md#focus-selection-and-active-rows)). The stronger active background is only applied to the file path currently opened in the active center editor panel.

Project Explorer owns panel-level keyboard shortcuts and passes `disableBuiltinKeyNav` to `FilesTree`. It still resolves tree keyboard input through the shared keybinding store, so these keys are remappable in Settings.

Keyboard behavior:

- `tree.focusNext`, `tree.focusPrevious`, `tree.focusFirstSibling`, `tree.focusLastSibling`, `tree.expandOrFocusChild`, `tree.collapseOrFocusParent`, and `tree.toggleExpanded` drive focus and expansion from the same row attributes as `FilesTree`; the Drafts rows form their own `data-tree-section`, so `Cmd+ArrowUp`/`Cmd+ArrowDown` on a root row stay within Drafts, the worktree root, or Others
- typing a name prefix jumps to the next visible matching row, as in `FilesTree`
- `tree.open` opens focused files and toggles focused directories; default `Enter`
- `tree.rename` starts inline rename for focused rows that are not fixed; defaults `F2` and `Shift+F6`
- canceling inline rename restores focus to the renamed row
- `Cmd+Z` / `Cmd+Shift+Z` undo and redo file operations
- `Cmd+X`, `Cmd+C` and `Delete` / `Backspace` act on the selected row unless it is fixed; `Cmd+V` pastes into the selected directory (or the selected file's directory), never into a draft or an Others file

## Tests

Behavior coverage lives in `src/components/panels/ProjectFilesPanel.dom.test.tsx` and, for detached-file destinations, `src/server/routes.detached.test.ts`.
