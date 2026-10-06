# Panels and layout

How the renderer's window is divided into dockview zones, how panels are registered, created, identified, focused and persisted per worktree.

For keyboard focus navigation, `activatePanel()` and find-in-panel, see [KEYBINDINGS.md](KEYBINDINGS.md). For the storage layer behind persisted layouts, see [STATE_AND_STORAGE.md](STATE_AND_STORAGE.md). For the overall process model, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Two nested dockviews

The window body is [App.tsx](../src/App.tsx): the worktree sidebar, the left tools bar, the **outer** dockview, the right tools bar, and the status bar underneath. The outer dockview is only mounted while a worktree is active.

- **Outer dockview** (`storagePrefix="outer"`): holds the sidebar tool panels in three zones (left, bottom, right) plus one `centerHost` panel. Every outer group header is hidden ([`applyHiddenHeaders`](../src/components/dockview/default-layout.ts)); the tools bars are the tab strip. The `centerHost` group is locked (`no-drop-target`).
- **Center dockview** (`storagePrefix="center"`): [CenterHost.tsx](../src/components/dockview/CenterHost.tsx) renders a second dockview inside `centerHost`. It holds all content panels (editors, terminals, agents, browsers, …), has visible tabs, splits freely, and shows `CenterWatermark` (the quickstart list) when empty.

Both registries live in [panels.tsx](../src/components/dockview/panels.tsx): `outerComponents`, `centerComponents` and `centerTabComponents`. `wrapPanelComponents` wraps every component in a [PanelErrorBoundary](../src/components/dockview/panel-error-boundary.tsx) (logs the error, shows the panel's icon and a retry button) and a full-size flex column, so panels never do this themselves.

Imperative code never holds a `DockviewApi`. Module-level references live in [tools-bar.ts](../src/store/tools-bar.ts): `setDockviewApi` (outer, set by `setupOuterDockview`), `getCenterApi` / `subscribeCenterApi` / `getCenterApiWorktree` (center, set by `CenterHost`). The center API is replaced on every worktree switch, so always re-read it.

Center panels that need their worktree get it from `params.worktreePath`, captured at creation, and expose it to descendants through [panel-context.ts](../src/components/dockview/panel-context.ts) (`usePanelWorktreePath`), so a panel keeps talking to the worktree it was created for.

Where to look:

- [outer-dockview-setup.ts](../src/components/dockview/outer-dockview-setup.ts): one-time outer setup, drop constraints, restore and resize callbacks.
- [default-layout.ts](../src/components/dockview/default-layout.ts): default outer layout, zone constraint re-application, layout-derived state, `nextPanelTitle`.
- [layout-actions.ts](../src/store/layout-actions.ts): `getGroupZone`, `collapseZone` / `expandZone`, `activatePanel`, `reattachActiveContent`, `findAdjacentCenterGroup`.

## Panel registry: `panel-config.ts`

[panel-config.ts](../src/store/panel-config.ts) is the single source of truth for both kinds of panel.

**Sidebar (tool) panels** are `SIDEBAR_PANELS`: `projectFiles`, `changes`, `git`, `comments`, `logs`, `forkTree`. Each has a `defaultZone`, `allowedZones` (drag constraint; `forkTree` cannot go to the bottom), `defaultActive`, a toolbar `icon`/`label` and an optional `dockviewTitle`. A sidebar panel's dockview id, component key and `PanelId` are the same string, and each exists at most once. Derived exports: `ALLOWED_ZONES`, `DEFAULT_TOOLBAR_ENTRIES`, `DEFAULT_ACTIVE_*`, `ZONE_DIRECTION_MAP`, `ZONE_INITIAL_SIZES`. `PanelId` also includes `diff` and `editor` (center-only) for old persisted layouts and `ALLOWED_ZONES`.

**Center panels** are `CENTER_PANELS` (`CenterPanelDef`): `type`, `idPrefix` (or exact id for singletons), dockview `component` and `tabComponent` keys, `icon`, `quickstartLabel` (shown in the watermark when non-null), `actionId` (the `panel.new.*` action), `createEvent` / `openEvent` (window event names), `titlePrefix`, `kind` (`connected-process`, `file-editor`, `state-view`) and `singleton`. `getCenterPanelDef(panelId)` classifies a dockview id by prefix (exact match for singletons); `isCenterPanel`, `QUICKSTART_PANELS` and `getCreateEventForAction` are derived from it.

### Zones

A group's zone is never stored: `getGroupZone` derives it from geometry relative to the center group (a group starting at or past the center's right edge is `right`; one whose top is at least 30% of the center's height below the center's top is `bottom`; anything else is `left`). `findZoneGroup` uses the tools-bar entries as candidates but validates each with `getGroupZone`.

Drop rules are enforced in `setupOuterDockview` (`onWillShowOverlay`): no edge drops, no drops on `centerHost`, only `position === "center"` (a zone is always a single tabbed group, never split), and `ALLOWED_ZONES` for dockview-native drags. Tools bar icons ([ToolsBarIcon.tsx](../src/components/tools-bar/ToolsBarIcon.tsx)) and sidebar panel headers ([DraggablePanelHeader.tsx](../src/components/panels/DraggablePanelHeader.tsx)) start HTML drags with the panel id as `text/plain`; dropping on an outer group (`onDidDrop`) or on a tools bar ([ToolbarZone.tsx](../src/components/tools-bar/ToolbarZone.tsx)) calls `movePanelToZone`.

## Panel identity and reuse

| Type            | Dockview id                 | Key params                                   | Open behavior                                                |
| --------------- | --------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `terminal`      | `terminal-<terminalId>`     | `terminalId`, `worktreePath`                 | Always new                                                   |
| `agent`         | `agent-<sessionId>`         | `sessionId`, `worktreePath`, fork params     | New; forks reuse the tab with the same `forkedSessionId`     |
| `browser`       | `browser-<uuid>`            | `url`, `faviconUrl`                          | Always new; `renderer: "always"`                             |
| `editor` (md)   | `editor-<filePath>`         | `filePath`, `worktreePath`, `line`, `column` | Reuse by path                                                |
| `codeEditor`    | `codeeditor-<filePath>`     | `filePath`, `worktreePath`, `line`, `column` | Reuse by path; `line`/`column` pushed via `updateParameters` |
| `excalidraw`    | `drawing-<filePath>`        | `filePath`, `worktreePath`                   | Reuse by path                                                |
| `media`         | `media-<filePath>`          | `filePath`, `worktreePath`                   | Reuse by path                                                |
| `agentDevTools` | `agentdevtools-<sessionId>` | `sessionId`                                  | Reuse by session; opens to the right of its agent tab        |
| `diff`          | `diff`                      | none                                         | Singleton                                                    |
| `localDb`       | `localdb-main`              | none                                         | Singleton                                                    |

File-backed ids embed the absolute path, so a file is open at most once per worktree layout. Reuse always goes through `activatePanel()`, never `panel.api.setActive()` (see [KEYBINDINGS.md](KEYBINDINGS.md#focus-navigation) and the browser note in [ELECTRON.md](ELECTRON.md#browser-panels)).

## Creating and opening panels

Creation is decoupled through typed window events. [loxel-events.ts](../src/lib/loxel-events.ts) defines `LoxelEventMap` plus `dispatchLoxelEvent` / `onLoxelEvent`; [useLoxelEventListeners.ts](../src/hooks/useLoxelEventListeners.ts) (mounted once in `App`) maps each `loxel-create-*` / `loxel-open-*` event to a function in [panel-creators.ts](../src/lib/panel-creators.ts). Event producers include the action handler (`panel.new.*` via `getCreateEventForAction`, `panel.split.*` with a `split` detail), the watermark quickstart, file openers and panel UIs. [StatusBar.tsx](../src/components/panels/StatusBar.tsx) and the browser tab's Duplicate item call the creators directly; Electron's "open in browser tab" IPC calls `createBrowser`.

`panel-creators.ts` functions are module-level (they run from events and store actions, outside React) and operate on `getCenterApi()`:

- Default placement is a new tab `within` the active panel's group (or the first panel's); a `SplitPosition` places it beside a reference panel instead. All placement is renderer-side. (Note: [src/server/placement.ts](../src/server/placement.ts) is unrelated; it places review comment threads, see [CODE_REVIEW.md](CODE_REVIEW.md).)
- `createEditor`, `createDrawing` and `createCodeEditor` first create a detached file on the server (`api.createDetachedFile`), so every editor is file-backed; module-level flags drop re-entrant calls while one is in flight.
- Untitled process/view panels get `nextPanelTitle` names: the lowest free number for the prefix, counting only the current worktree's layout.
- `openFileBacked(type, filePath, extra?, placement?)` is the single open-or-focus path for file panels.

### Routing paths to panels

- [open-file.ts](../src/lib/open-file.ts): `filePanelType` picks the panel by extension (`.md` → `editor`, `.excalidraw` → `excalidraw`, media extensions → `media`, else `codeEditor`); `dispatchOpenFile` fires the matching `loxel-open-*` event. Use it rather than choosing a panel type yourself.
- [open-path.ts](../src/lib/open-path.ts): entry points for paths from outside the window (`loxel <path>`, Finder, terminal links). `openFile` resolves the owning worktree; if that worktree's center is not mounted yet (switch in progress, first mount) the path is queued in its [worktree-ui](../src/store/worktree-ui.ts) `pendingOpenFiles`, and the next `CenterHost` for that worktree drains the queue in a microtask once its API is ready. `openFolder` reveals the folder in `projectFiles`, using `showPanelAfterLayoutRestore` when it had to switch worktrees. `openPath` asks the server whether the path is a directory.

### File and panel lifecycle

- `handleFileMoved` (on `loxel-file-moved`, e.g. after a rename) replaces the old tab with one for the new path at the same index, keeps it visible only if it was, never changes the active group, and migrates editor/drawing caches. Covered by [panel-creators.test.ts](../src/lib/panel-creators.test.ts).
- `handleFileDeleted` closes tabs for the path and anything under it.
- `CenterHost`'s `onDidRemovePanel` owns close-side effects: terminals send `terminal_destroy` and unregister notifications, agents send `agent_detach`, DevTools drop their session, and files outside the worktree send `close_external_file`. It is skipped while either layout is swapping, so a worktree switch does not kill PTYs or agents.

## Tabs and context menus

[tab.tsx](../src/components/dockview/tab.tsx) is the shared tab: optional `leading` (status dot), icon, title, `trailing` actions, close button, and a context menu with optional extra items above Close / Close Others / Close All. Passing `onRename` enables inline rename (double-click or menu); while renaming it stops dockview's native pointer listeners at the input and suspends the tab's `draggable`. Each center type has a thin tab in `src/components/dockview/*-tab.tsx`.

Title source differs by kind. File-backed tabs ([editor-tab.tsx](../src/components/dockview/editor-tab.tsx), [media-tab.tsx](../src/components/dockview/media-tab.tsx)) render the file name from `params.filePath`, and renaming renames the file on disk via [useFileTabRename.ts](../src/hooks/useFileTabRename.ts) (only where the project files tree could rename it); the resulting file-moved event swaps the panel. Terminal tabs rename with `api.setTitle`, which is persisted in the layout JSON. Use `usePanelTitle(api)` to render a title that can change.

`FileContextMenuItems` (in `tab.tsx`) adds Copy File Name / Relative Path / Absolute Path and [OpenInMenuItems](../src/components/menus/OpenInMenuItems.tsx) (Reveal in Finder plus an "Open In" submenu, macOS only, app list fetched when the submenu opens). Context menus are controlled components: hold `open` and the pointer `position` in state and render `ContextMenu` from [context-menu.tsx](../src/components/ui/context-menu.tsx); larger menus live in [src/components/menus/](../src/components/menus/). Copy through [clipboard.ts](../src/lib/clipboard.ts), which logs failures.

## Focus and activation

- [usePanelActive.ts](../src/hooks/usePanelActive.ts): whether the panel is its group's active tab (defaults to `true` when given no API).
- [usePanelActivationFocus.ts](../src/hooks/usePanelActivationFocus.ts): calls the panel's focus function when the panel is both active in its group and in the active group (dockview's `setActive` does not move DOM focus), including after moves, and registers it in [panel-focus.ts](../src/lib/panel-focus.ts) so keyboard navigation can re-focus an already-active panel. Used by the code, markdown and drawing editors, terminal, browser and agent panels; `ProjectFilesPanel` registers with `registerPanelFocus` directly.
- [useZoomFactor.ts](../src/hooks/useZoomFactor.ts): Electron page zoom factor, used by [TopBar.tsx](../src/components/panels/TopBar.tsx) to keep the traffic-light inset fixed.

Spatial navigation, focus targets and find are covered in [KEYBINDINGS.md](KEYBINDINGS.md).

## Tools bars and zone state

Per-worktree zone state is [worktree-tools-bar.ts](../src/store/worktree-tools-bar.ts), a [`createWorktreeStore`](../src/store/worktree-store.ts) instance: `left/bottom/rightEntries` (icon order per zone), `activeLeft/Bottom/RightPanel` (`null` = zone collapsed), `terminals` (PTY bookkeeping) and `sidebarSizes`. It is in memory only; see persistence below.

Operations are in [tools-bar.ts](../src/store/tools-bar.ts): `togglePanel` (flip the zone's active panel, clear its badge, expand/collapse the zone), `showPanel`, `showPanelAfterLayoutRestore` (queue until the next outer restore), `movePanel` (entries only, after dockview already moved it) and `movePanelToZone` (entries and dockview; re-adds the panel next to `centerHost` when the target zone has no group). UI callers use `toggleSidebarPanel` in [focus-navigation.ts](../src/lib/focus-navigation.ts), which also moves focus.

A collapsed zone keeps its group: `collapseZone` pins its size to 0 with constraints and `expandZone` lifts them and restores `sidebarSizes`. This is imperative, not effect-driven, because effects would run after a restore and apply another worktree's sizes. dockview does not serialize constraints, so `onOuterLayoutRestored` re-applies them (`applyZoneConstraints`) after every restore.

[LeftToolsBar.tsx](../src/components/tools-bar/LeftToolsBar.tsx) renders the left and bottom zones; [RightToolsBar.tsx](../src/components/tools-bar/RightToolsBar.tsx) renders the right zone and is hidden when it has no entries.

### Worktree sidebar

[Sidebar.tsx](../src/components/sidebar/Sidebar.tsx) (projects and worktrees) sits outside dockview. Its `sidebarExpanded` / `sidebarWidth` live in [projects.ts](../src/store/projects.ts) and persist through the server-backed `persist` storage; widths are clamped to 200–560 px (default 240, collapsed 48). [SidebarResizeHandle.tsx](../src/components/sidebar/SidebarResizeHandle.tsx) reports live widths while dragging and commits once when the drag ends, so the store is written once per drag.

## Badges, notifications and status bar

- [panel-badges.ts](../src/store/panel-badges.ts): global counts per sidebar `PanelId`, shown as a dot on the tools bar icon while the panel is not active and cleared by `togglePanel`. Only `logs` uses it today: it reconciles against the server's monotonic error total using a `lastSeenErrorTotal` kept in `localStorage`.
- [panel-notifications.ts](../src/store/panel-notifications.ts): a mirror of the server's notification store; `panelIndex` drives terminal tab dots and `worktreeIndex` drives worktree dots in the sidebar. Notification sources, replay suppression and navigation are in [TERMINALS.md](TERMINALS.md#notifications).
- [NotificationBell.tsx](../src/components/notifications/NotificationBell.tsx) (in the top bar) lists notifications. `useLoxelEventListeners` mirrors the count to the macOS dock badge.
- [StatusBar.tsx](../src/components/panels/StatusBar.tsx): git status of the active worktree, the pending-chord indicator, and quick-create buttons.

## Command palette and actions

[CommandPaletteModal.tsx](../src/components/command-palette/CommandPaletteModal.tsx) lists every `ACTIONS` entry from the [action registry](../src/store/keybindings/action-registry.ts) that is not `hidden`, fuzzy-matched on its label, with its current binding. It runs the chosen action through [useActionHandler.ts](../src/hooks/useActionHandler.ts) on the next animation frame, after the dialog closes, so actions that open dialogs or move focus are not fighting the palette. [command-palette.ts](../src/store/command-palette.ts) only holds `isOpen` and `query`; the `nav.commandPalette` action opens it.

`useActionHandler` is the single action dispatcher for keybindings and the palette. Panel actions resolve against `getCenterApi()`: `panel.new.*` dispatch the registry's `createEvent`; `panel.split.<dir>` / `panel.split.<type>.<dir>` / `panel.newTab` create a panel of the active (or given) type, refusing to clone singletons; `toggle.<panelId>` toggles sidebar panels. Its `switch` is exhaustive over `ActionId`, so a new action fails typechecking until handled.

## Layout persistence and worktree switches

[PersistedLayout.tsx](../src/components/dockview/PersistedLayout.tsx) wraps `DockviewReact` for both dockviews; `layoutKey` is the active worktree path.

- **Storage** (per-window session and canonical keys, restore order, debounced saves, promotion on window close, crash recovery) is owned by [STATE_AND_STORAGE.md](STATE_AND_STORAGE.md#layout-persistence). A version mismatch discards the saved layout (`LAYOUT_VERSION` in `default-layout.ts` for the outer layout, `CENTER_LAYOUT_VERSION` in `CenterHost.tsx`).
- **Defaults.** When nothing is saved, `createDefaultLayout` runs: the outer default is built from `SIDEBAR_PANELS` and the user's layout settings (`getEffectiveLayoutConfig` in [settings-store.ts](../src/store/settings-store.ts)), the center default is empty.
- **What is persisted** is only the dockview JSON (ids, params, titles, groups, sizes). The tools-bar store is rebuilt from it: `syncSidebarFromLayout` derives zone entries and sizes from the outer layout, and `syncTerminalsFromLayout` rebuilds terminal bookkeeping after every center restore.

On a worktree switch `activeWorktreePath` changes, so both `PersistedLayout`s see a new `layoutKey`. Each saves the outgoing layout to an in-memory cache and its session row, clears, then restores the new key from cache, server or default. The outer clear sets `outerSwapping` and removes `centerHost`, unmounting `CenterHost`; a fresh `CenterHost` then mounts for the new worktree with its own center layout. `onOuterLayoutRestored` re-hides headers, re-activates the store's active panels, re-applies zone constraints, clears `outerSwapping` and opens panels queued by `showPanelAfterLayoutRestore`. Because the layout is rebuilt, browser panels reload on a switch. Per-worktree store instances survive switches and are purged when a worktree is removed (`purgeWorktreeStores`).

In parallel, [useWsSubscription.ts](../src/hooks/useWsSubscription.ts) (called from `App`) subscribes the WebSocket to the new worktree and unsubscribes the old one only after its pending editor saves drain, so auto-saves flushed while the old panels unmount still reach a live server worktree.

## Adding a panel type

Center (content) panel:

1. Add a `CENTER_PANELS` entry in [panel-config.ts](../src/store/panel-config.ts). For a singleton, the dockview id must equal `idPrefix` exactly or `getCenterPanelDef` will not recognize it.
2. Register the component in `centerComponents` in [panels.tsx](../src/components/dockview/panels.tsx). Read params, pass `props.api` down, and wrap in `PanelContext.Provider` if descendants need the worktree.
3. Add a tab in `src/components/dockview/<type>-tab.tsx` built on `Tab` (or `EditorTab` for files) and register it in `centerTabComponents`.
4. Add events to `LoxelEventMap`, a creator/opener in [panel-creators.ts](../src/lib/panel-creators.ts) (decide the reuse rule; reuse via `activatePanel`), and a listener in [useLoxelEventListeners.ts](../src/hooks/useLoxelEventListeners.ts).
5. If it opens files, extend `FilePanelType` / `filePanelType` / `dispatchOpenFile` in [open-file.ts](../src/lib/open-file.ts).
6. For a keybinding or palette entry, add the `ActionId` and `ACTIONS` entry in [action-registry.ts](../src/store/keybindings/action-registry.ts), a default in [keybinding-schema.ts](../src/store/keybindings/keybinding-schema.ts) if any, set `actionId` in the registry entry, and add the id to the `panel.new.*` no-op cases in `useActionHandler`. Add it to `SPLIT_PANEL_TYPES` for split actions.
7. Add close-side cleanup (server resources, store entries) to `onDidRemovePanel` in [CenterHost.tsx](../src/components/dockview/CenterHost.tsx).
8. Give it a focus target (`usePanelActivationFocus` or `panelAutofocusProps`) and, if searchable, `usePanelFind`; see [KEYBINDINGS.md](KEYBINDINGS.md). Use `renderer: "always"` only if re-attaching its DOM is destructive.

Sidebar (tool) panel:

1. Add the id to `PanelId` and a `SIDEBAR_PANELS` entry in [panel-config.ts](../src/store/panel-config.ts).
2. Register the component in `outerComponents` in [panels.tsx](../src/components/dockview/panels.tsx); use `DraggablePanelHeader` for its header so it can be dragged between zones.
3. Add a `toggle.<id>` action, its `useActionHandler` case, and optionally a default binding.
4. Saved outer layouts and saved layout settings (`zonePanelOrder`) predate the panel, and nothing adds missing sidebar panels on restore; decide whether to bump `LAYOUT_VERSION` (resets all saved outer layouts) and add a settings migration.
