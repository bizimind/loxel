# Keybindings, focus and find

How app shortcuts, keyboard focus navigation and find-in-panel are wired. For the user-facing list of default shortcuts, see the site's [Keyboard Shortcuts](../../site/src/content/docs/reference-keybindings.md) page; keep it in sync when defaults change. The modules below carry the detailed behavior in their header comments.

## Actions and bindings

| Module                                       | Role                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/store/keybindings/action-registry.ts`   | Every action (`ActionDef`): id, label, category, `hidden`, `isEnabled`, `sharesKeyWith`       |
| `src/store/keybindings/keybinding-schema.ts` | Default bindings (the "Loxel Default" template)                                               |
| `src/store/keybindings/keybinding-store.ts`  | Template + user overrides (Settings > Keybindings), derived reverse lookup and chord prefixes |
| `src/store/keybindings/key-combo.ts`         | Key combo / chord parsing and normalization                                                   |
| `src/store/keybindings/pending-chord.ts`     | Keystroke resolution, including in-progress chords                                            |
| `src/hooks/useKeybindings.ts`                | Document-level listener that resolves keystrokes and dispatches actions                       |
| `src/store/keybindings/mac-window-tiling.ts` | macOS window tiling keys kept from widgets so they reach the Window menu                      |
| `src/components/settings/KeyRecorder.tsx`    | Recording a binding in Settings, and which chords are allowed                                 |

Conventions:

- **Every shortcut is an action.** Add an `ActionDef` and a default binding rather than a local `keydown` handler, so it shows in the command palette and can be remapped. `hidden: true` keeps internal actions (tree navigation, the palette itself) out of the palette.
- **Context-dependent actions declare `isEnabled`.** A disabled action's key resolves as unbound, so it reaches the focused widget instead (for example `⌃⇧Space` in the center goes to the terminal or editor, and `⌘F` outside a find target goes to Monaco's own find widget). The command palette lists only the actions enabled where focus was when it opened (it takes focus itself, and the dialog gives it back before the chosen action runs).
- **Sharing a key.** Two actions enabled in different places can hold the same key: one declares `sharesKeyWith`, the binding's `lookup` entry lists both, and a keystroke runs whichever is enabled where focus is (the declaring one, if both are). `browser.hardRefresh` shares `⇧⌘R` with `panel.rename` this way. Each stays its own action: it has its own row in Settings > Keybindings, remapping one leaves the other on the key without reporting a conflict, and any other action taking the key (or a chord starting with it) removes it from both.
- **Reserved keys.** Defaults stay clear of macOS text editing, Monaco's defaults and Rectangle's global `⌃⌥` shortcuts (Restore on `⌃⌥⌫` is why Delete Worktree has no default key). The "no default binding takes reserved keys" test in `keybinding-validation.test.ts` enforces this; extend its list when reserving a new key. macOS 15+ window tiling (fn⌃ / fn⌃⇧ arrows, which reach the page as `⌃`/`⌃⇧` Home, End, PageUp and PageDown) runs from the Window menu, which only gets the tiling items because the app menu's Window submenu has the `window` role (`src/electron/main.ts`), and only for a keydown the page leaves unhandled. So `useKeybindings` stops those keys before any widget sees them when no binding takes them, and defaults must not bind them (enforced by the "no default binding takes a macOS window tiling shortcut" test).
- **Chords** are up to three keystrokes. A single-key binding takes precedence over a chord with the same first key, and remapping removes overlapping bindings (equal, or a chord prefix) from other actions, apart from a key they may share.

## Focus navigation

`src/lib/focus-navigation.ts` implements `⌃⇧`+arrow spatial navigation across the window's areas (worktree sidebar, tool bars, center groups, bottom panel). The current area is read from DOM focus, so mouse clicks and keyboard navigation agree.

A panel takes focus through, in order: the function it passes to `usePanelActivationFocus` (`src/hooks/usePanelActivationFocus.ts`, registered in `src/lib/panel-focus.ts` so an already-active panel can be re-focused), its `panelAutofocusProps()` element (`src/lib/focus-targets.ts`), or its first tabbable element. New panels with a non-obvious focus target should use one of the first two.

Activating a panel that is already its group's active tab must go through `activatePanel()` (`src/store/layout-actions.ts`), not `panel.api.setActive()`, which re-attaches the content and would reload a browser panel's page.

## Find in panel

Panels opt in to `⌘F` / `⌘G` / `⇧⌘G` by registering their root element with `src/lib/find-targets.ts` (via `src/hooks/usePanelFind.ts`) and rendering the shared `FindBar` (`src/components/ui/find-bar.tsx`). The `find.*` actions are enabled only while focus is inside a registered target. Browser panels and terminals are the current targets.

## Shortcuts inside browser panels

Keys typed in a `<webview>` go to the guest page, never the window's document. The renderer tells the Electron main process which keystrokes to intercept (the first keystroke of every binding enabled where focus is, or every keystroke while a chord is in progress); the main process withholds those from the page and forwards them back, where they are resolved like document keys. See `src/electron/webview-keystrokes.ts` and the IPC constants in `src/electron/ipc-channels.ts`. The interception set must be re-sent whenever what is enabled can change (focus moves, a find or hard refresh target is registered or removed), or a context-disabled key would be taken from the page.

The browser panel's hard refresh (`src/lib/hard-refresh-targets.ts`) is registered by element like find targets and takes `⇧⌘R` from the page the same way, through the shared `src/lib/focus-target-registry.ts`. `canRenameActiveTab` is false wherever a browser panel holds focus, since browser tabs register no rename, so focus decides which of the two runs.

## Editor code actions

The `codeAction.*` actions (Quick Fix, Fix All, Organize Imports, Source Action, Refactor) live in `src/lib/editor-code-actions.ts`. Each is enabled while the focused Monaco editor, picked as Monaco picks it (the editor with text focus, else the last with widget focus, so a peek preview wins over the tab around it), is writable and shows an editor tab's live model, and one of the file's language clients may offer its kind, checked with `MonacoLspClient.supportsCodeActionKind` over every connected client (`getAllConnectedLspClients`) (Quick Fix accepts a quick fix or a refactor, since its menu lists both; Fix All and Organize Imports need a server that declares the kind, since Monaco runs them only then), and runs Monaco's own command on that editor. Monaco asks every provider of the file and applies the only Fix All or Organize Imports action or shows a picker, so when several servers serve a file (ruff and basedpyright) the user picks between their answers rather than Loxel choosing a server. Quick Fix and Organize Imports default to Monaco's keys, and Loxel takes them only where it runs the same command on the same editor; Monaco's Refactor key (`⌃⇧R`) is Toggle Comments here.

## Worktree history

`src/store/worktree-history.ts` keeps browser-like back/forward stacks of visited worktrees across all projects, per window and not persisted.
