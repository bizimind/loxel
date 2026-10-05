# Keybindings, focus and find

How app shortcuts, keyboard focus navigation and find-in-panel are wired. For the user-facing list of default shortcuts, see the site's [Keyboard Shortcuts](../../site/src/content/docs/reference-keybindings.md) page; keep it in sync when defaults change. The modules below carry the detailed behavior in their header comments.

## Actions and bindings

| Module                                       | Role                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/store/keybindings/action-registry.ts`   | Every action (`ActionDef`): id, label, category, `hidden`, `isEnabled`                        |
| `src/store/keybindings/keybinding-schema.ts` | Default bindings (the "Loxel Default" template)                                               |
| `src/store/keybindings/keybinding-store.ts`  | Template + user overrides (Settings > Keybindings), derived reverse lookup and chord prefixes |
| `src/store/keybindings/key-combo.ts`         | Key combo / chord parsing and normalization                                                   |
| `src/store/keybindings/pending-chord.ts`     | Keystroke resolution, including in-progress chords                                            |
| `src/hooks/useKeybindings.ts`                | Document-level listener that resolves keystrokes and dispatches actions                       |
| `src/components/settings/KeyRecorder.tsx`    | Recording a binding in Settings, and which chords are allowed                                 |

Conventions:

- **Every shortcut is an action.** Add an `ActionDef` and a default binding rather than a local `keydown` handler, so it shows in the command palette and can be remapped. `hidden: true` keeps internal actions (tree navigation, the palette itself) out of the palette.
- **Context-dependent actions declare `isEnabled`.** A disabled action's key resolves as unbound, so it reaches the focused widget instead (for example `⌃⇧Space` in the center goes to the terminal or editor, and `⌘F` outside a find target goes to Monaco's own find widget).
- **Reserved keys.** Defaults stay clear of macOS text editing, Monaco's defaults and Rectangle's `⌃⌥` window snapping (which is why Delete Worktree has no default key). The "no default binding takes reserved keys" test in `keybinding-validation.test.ts` enforces this; extend its list when reserving a new key.
- **Chords** are up to three keystrokes. A single-key binding takes precedence over a chord with the same first key, and remapping removes overlapping bindings (equal, or a chord prefix) from other actions.

## Focus navigation

`src/lib/focus-navigation.ts` implements `⌃⇧`+arrow spatial navigation across the window's areas (worktree sidebar, tool bars, center groups, bottom panel). The current area is read from DOM focus, so mouse clicks and keyboard navigation agree.

A panel takes focus through, in order: the function it passes to `usePanelActivationFocus` (`src/hooks/usePanelActivationFocus.ts`, registered in `src/lib/panel-focus.ts` so an already-active panel can be re-focused), its `panelAutofocusProps()` element (`src/lib/focus-targets.ts`), or its first tabbable element. New panels with a non-obvious focus target should use one of the first two.

Activating a panel that is already its group's active tab must go through `activatePanel()` (`src/store/layout-actions.ts`), not `panel.api.setActive()`, which re-attaches the content and would reload a browser panel's page.

## Find in panel

Panels opt in to `⌘F` / `⌘G` / `⇧⌘G` by registering their root element with `src/lib/find-targets.ts` (via `src/hooks/usePanelFind.ts`) and rendering the shared `FindBar` (`src/components/ui/find-bar.tsx`). The `find.*` actions are enabled only while focus is inside a registered target. Browser panels and terminals are the current targets.

## Shortcuts inside browser panels

Keys typed in a `<webview>` go to the guest page, never the window's document. The renderer tells the Electron main process which keystrokes to intercept (the first keystroke of every binding enabled where focus is, or every keystroke while a chord is in progress); the main process withholds those from the page and forwards them back, where they are resolved like document keys. See `src/electron/webview-keystrokes.ts` and the IPC constants in `src/electron/ipc-channels.ts`. The interception set must be re-sent whenever what is enabled can change (focus moves, a find target is registered or removed), or a context-disabled key would be taken from the page.

## Worktree history

`src/store/worktree-history.ts` keeps browser-like back/forward stacks of visited worktrees across all projects, per window and not persisted.
