# Terminal Tab & Panel Shortcuts (Deferred)

These shortcuts need to integrate with the dockview panel system and should be implemented at the app level. Terminals are multi-instance center panels (like editors and drawings), managed by dockview's tab and split system.

## Tab Management

| Shortcut    | Action                  | Notes                                      |
| ----------- | ----------------------- | ------------------------------------------ |
| Cmd+T       | New terminal tab        | Currently handled as Cmd+N inside terminal |
| Cmd+1–9     | Switch to tab by number | Cmd+9 = last tab (iTerm2 convention)       |
| Cmd+Shift+[ | Previous tab            |                                            |
| Cmd+Shift+] | Next tab                |                                            |

## Split Panes

| Shortcut        | Action                        | Notes             |
| --------------- | ----------------------------- | ----------------- |
| Cmd+D           | Split pane vertically         | iTerm2 convention |
| Cmd+Shift+D     | Split pane horizontally       | iTerm2 convention |
| Cmd+Opt+Arrow   | Navigate between panes        |                   |
| Cmd+Shift+Enter | Maximize/restore current pane |                   |

## Window

| Shortcut                | Action            | Notes                            |
| ----------------------- | ----------------- | -------------------------------- |
| Cmd+Enter or Ctrl+Cmd+F | Toggle fullscreen | Conflicts across apps — pick one |

## Implementation Notes

- These operate on the dockview layout, not on xterm.js instances
- Key events should be captured at the app level
- Tab switching needs access to the dockview API (`api.getPanel`, `api.setActivePanel`)
- Split pane creation needs the dockview `addPanel` API with direction hints
- Consider whether these shortcuts should be global (work even when terminal isn't focused) or terminal-scoped
