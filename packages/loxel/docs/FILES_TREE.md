# FilesTree Behavior

Behavior contract of `FilesTree` (`src/components/tree/`), the shared React tree component used by the Project Explorer and the Changes panel.

`FilesTree` owns rendering, keyboard interaction, lazy subtree loading, row compaction, focus, and imperative operations such as reveal and reload. Callers supply panel-specific data, labels, row props, selection state, and file actions.

## Identity

Every `TreeNode.path` is the canonical identity for that row. The same path is used for expansion, selection, focus, keyboard navigation, context menus, drag and drop, reloads, and reveal.

Callers must pass stable path identities. A tree should not mix relative and absolute paths for the same logical node. The Project Explorer uses absolute paths (see [PROJECT_EXPLORER.md](PROJECT_EXPLORER.md)). The Changes panel (`FileTreePanel`) uses diff file paths.

`nodes` may hold several roots. `renderRootHeader(node, index)` renders content above a root, which the Project Explorer uses for its Others section heading.

## Expansion State

`FilesTree` supports both internal and controlled expansion:

- `defaultExpandedPaths` seeds internal expansion state.
- `expandedPaths` and `onExpandedPathsChange` make expansion controlled by the caller.
- `autoExpandDirs` expands every directory in `nodes` whenever `nodes` changes (used by the Changes panel).
- `expandPath(path)` imperatively expands a directory.
- `togglePath(path)` toggles a directory using the same path identity as the rendered row.

Controlled expansion updates are optimistic inside `FilesTree`: consecutive imperative expansions in one async flow are based on the latest requested set, not a stale prop snapshot. This matters for `revealPath()`, which may expand several ancestors before React has re-rendered the controlled state.

User-collapsed paths are tracked separately from loaded children. Automatic expansion (`autoExpandDirs` and single-child auto-expansion) must not re-open a directory the user explicitly collapsed.

## Lazy Loading

When a directory is expanded and has no inline `children` and no cached children, `FilesTree` calls `loadSubtree(path)`.

Loaded children are cached under the exact path passed to `loadSubtree()`. `reloadSubtree(path)` invalidates and reloads the same cache key. `clearSubtree(path)` removes cached entries for `path` and descendants.

If a load is already in flight for a path, later callers await the same promise. Load failures are reported through `onLoadError(path, error)` instead of creating unhandled promise rejections.

If a loaded directory has exactly one directory child, `FilesTree` auto-expands that child so it can be compacted (see below). It skips this auto-expansion when that child path is recorded as user-collapsed.

## Row Compaction

An expanded directory with exactly one child that is itself a directory renders as one combined row, `parent / child`. The child's own children render below that row and can be compacted the same way. `compactRoot` controls whether a root-level directory can be compacted:

- `compactRoot={true}` is the default.
- `compactRoot={false}` keeps top-level roots, such as the Project Explorer worktree root, visible as their own rows.

For compacted rows, the canonical row identity is the leaf (child) directory path. The leaf node is passed to:

- row data attributes
- selection and focus logic
- keyboard toggling
- context menu callbacks
- row props and class callbacks
- trailing render callbacks
- reveal lookup
- drag and drop row props

`renderLabel(node, compactedWith)` still receives both nodes so callers can render a combined label, but actions target the leaf path.

## Focus, Selection, And Active Rows

Rows expose their canonical path through `data-tree-path` (plus `data-tree-dir`, `data-tree-expanded` and `data-tree-depth`). `FilesTree` calls `onSelect(path)` when a row receives focus. Focus entering the tree container from outside is moved to the selected row, else the first row.

The optional `focusedPath` prop marks the matching row (`data-tree-selected`) and focuses it when focus is already inside the tree. This keeps external selection state and DOM focus aligned without stealing focus from unrelated UI. `focusPath(path)` focuses a row once it renders, and `focusTree()` focuses the selected or first row.

`focusedPath` is not the active/opened visual state. Mouse hover gets a light tint (`bg-primary/20` in the dark theme, `/40` in the light theme, whose primary is paler). The focused row — reached by keyboard or by clicking it, since a click focuses its row — gets a stronger tint (`/50` dark, `/80` light) and an inset `ring-1` outline, so hover and focus never look alike. The active row keeps its own background and also gets the outline when focused.

The optional `activePath` prop marks the entry currently opened in the active center panel. Only `activePath` receives the stronger active background (`bg-primary` when the owning panel is active, `bg-muted` when it is not). Rows expose this state through `data-tree-active`.

## Keyboard

When built-in keyboard handling is enabled, keyboard input is resolved through the keybinding store (defaults in `src/store/keybindings/keybinding-schema.ts`). The tree actions are remappable in Settings but hidden from the command palette, and the global keybinding listener ignores them; they only apply while focus is inside a tree.

- `tree.focusNext` moves focus to the next visible row. Default: `ArrowDown`.
- `tree.focusPrevious` moves focus to the previous visible row. Default: `ArrowUp`.
- `tree.focusFirstSibling` / `tree.focusLastSibling` move focus to the first / last row in the focused row's folder (expanded children of its siblings are skipped). Root rows are siblings within their section only: `FilesTree` wraps each group of roots that starts at a `renderRootHeader` header in a `data-tree-section` element. Defaults: `Cmd+ArrowUp` / `Cmd+ArrowDown`.
- `tree.expandOrFocusChild` expands a collapsed directory or focuses its first child. Default: `ArrowRight`.
- `tree.collapseOrFocusParent` collapses an expanded directory or focuses its parent. Default: `ArrowLeft`.
- `tree.toggleExpanded` toggles the focused directory. Default: `Space`.
- `tree.open` opens focused files and toggles focused directories. Default: `Enter`.
- `tree.rename` is exposed for panels that support inline rename. Defaults: `F2`, `Shift+F6`.
- Type-ahead: a printable character without Cmd/Ctrl/Alt that no tree action takes moves focus to the next visible row whose `data-tree-name` starts with it (case-insensitive, wrapping around). Characters typed within 500ms of each other build up one prefix, which may include keys bound to tree actions such as Space; repeating one character steps through the names starting with it. Any tree action ends the prefix. A compacted row matches on its first segment.

Callers can pass `disableBuiltinKeyNav` when a surrounding panel owns keyboard shortcuts. In that case the caller should still use the row `data-tree-path` and `data-tree-dir` attributes so keyboard behavior targets the same canonical row identity as mouse behavior, and resolve tree keyboard input through `useTreeKeyboardNav` / `getTreeActionForEvent()` instead of hardcoding key names.

## Reveal

`revealPath(path)` returns a promise. It loads and expands relevant lazy ancestors, then focuses the target row and scrolls it into view.

Expected behavior:

1. Find the deepest known ancestor matching the target path.
2. Expand each ancestor on the target path.
3. Load lazy subtrees as needed.
4. After React renders the target row, focus it with `preventScroll: true`.
5. Scroll it into view with `{ block: "center", behavior: "smooth" }`.
6. Resolve the promise after focus and scroll have been applied.

Reveal is implemented with React state and a layout effect after render. It does not use `MutationObserver`.

If the target cannot be found after loading the known path, `revealPath()` returns without waiting forever.

## Reload And Rename

`reloadSubtree(path)` refreshes a loaded subtree under the same path identity the renderer reads.

`handlePathsRenamed(oldPrefix, newPrefix)` remaps expansion state, cached children, and collapsed paths. Callers are responsible for remapping their own external selection state.

## Tests

Behavior coverage lives in `src/components/tree/FilesTree.dom.test.tsx`, with type-ahead matching unit-tested in `src/hooks/useTreeKeyboardNav.test.ts`.
