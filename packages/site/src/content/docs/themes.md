---
title: Themes
description: Color themes for Loxel, its terminals and code, one for light mode and one for dark mode, with an editor, terminal colors from iTerm2, Windows Terminal and VS Code files, and theme.json files to share or back up.
section: "In the code"
order: 6
---

A theme colors all of Loxel at once: its windows, panels and dialogs, its terminals, and the code in editors, diffs and markdown. Loxel comes with **Loxel Light** and **Loxel Dark**, and you can make your own from them.

---

## Choosing themes

Pick a theme for each mode in **Settings > Appearance > Color Themes**: one for **Light mode** and one for **Dark mode**. **Settings > Appearance > Theme** chooses the mode: Dark, Light, or System, which follows your Mac's appearance and switches between your two themes with it. Each mode lists only the themes made for it, so a dark theme is always used in dark mode.

Open editors and terminals switch to a new theme at once. **Cancel** in Settings puts back the themes and colors you had when you opened it.

---

## Making a theme

Click the copy button beside a theme to **Duplicate** it. The copy becomes its mode's theme and opens in the theme editor, where you can rename it and change its colors:

| Group               | What it colors                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Surfaces            | The window, editor and terminal backgrounds, panels, bars, menus and inputs                     |
| Text                | Text everywhere, and secondary text                                                             |
| Accent and controls | Selections, links, buttons, focus rings, borders, scrollbars, errors and warnings               |
| Editor              | Line numbers and folders in file trees                                                          |
| Git                 | Modified and untracked files, branch and tag badges, and the branch lines of the commit graph   |
| Diff                | Added, deleted and modified lines and text, their gutters, and collapsed lines                  |
| Comments            | Commented code and comment markers                                                              |
| Terminal            | The terminal's 16 ANSI colors, its text, cursor and selection                                   |
| Syntax              | Code by kind: comments, keywords, strings, numbers, types, functions, properties, tags and more |

Click a swatch to pick a color, which applies as you pick, or type a color and press Enter: hex such as `#0f1a2b` or `#0f1a2bcc`, `rgb()`, `hsl()`, `oklch()`, `lab()` or `lch()` with numbers, `black`, `white` or `transparent`. A color you changed shows a reset button that puts back the color of the theme it's built on. Loxel Light and Loxel Dark themselves can't be changed: duplicate them instead.

A terminal always sits on its theme's editor surface, so its background follows the **Editor and terminal** color rather than a color of its own. A light theme keeps terminal text readable on its surface by darkening colors that would be too faint.

### Terminal colors from other apps

In the theme editor's **Terminal** group, click **Import ANSI Colors…** to take the 16 ANSI colors of a terminal color scheme file. The rest of the scheme, its background, text and cursor colors, isn't used: the terminal keeps the colors of your theme around it.

| Format           | File                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| iTerm2           | An `.itermcolors` file. For a profile with separate light and dark mode colors, those of the theme's mode                             |
| Windows Terminal | A JSON file with one scheme, a list of schemes, or a `settings.json` with a `schemes` list; the first scheme in it                    |
| VS Code          | A color theme JSON file that sets the `terminal.ansi*` colors, or a `settings.json` that sets them in `workbench.colorCustomizations` |

A scheme needs all 16 ANSI colors; Settings tells you which ones a file lacks.

---

## Sharing and backing up themes

Click the download button beside a theme to **Export** it as a `.theme.json` file. **Import Theme…** reads one back, on this Mac or another, and makes it its mode's theme. Importing a theme with the name and mode of one of yours replaces that theme, so importing a backup restores it.

Themes are saved with your settings, on your computer. Importing and exporting only reads and writes the files you choose.

### The theme.json format

A theme file holds only the colors the theme changes. The theme it's built on, Loxel Light or Loxel Dark, fills in the rest, so a theme keeps working as Loxel adds colors:

```json
{
  "loxelTheme": 1,
  "name": "Harbor Night",
  "base": "dark",
  "colors": { "editor-surface": "#0f1a2b", "card": "#0b1422", "foreground": "#d4dcea" },
  "terminal": { "foreground": "#d4dcea", "red": "#e8676b", "brightRed": "#ff8a8e" },
  "syntax": { "keyword": "#c792ea", "string": "#aee59a", "comment": "#5f7391" }
}
```

| Key          | Value                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loxelTheme` | The format version, `1`                                                                                                                                                                 |
| `name`       | The theme's name; without one, the file's name                                                                                                                                          |
| `base`       | `"light"` or `"dark"`: the theme it's built on, and the mode it's for                                                                                                                   |
| `colors`     | Loxel's colors, by the names below                                                                                                                                                      |
| `terminal`   | `foreground`, `cursor`, `selection`, and the ANSI colors `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white` and their `bright` forms (`brightBlack` … `brightWhite`) |
| `syntax`     | Code colors by kind, by the names below                                                                                                                                                 |

The names in `colors`, by group. Those marked (light) are drawn only by light themes:

| Group               | Names                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces            | `background`, `editor-surface`, `surface-0`, `surface-1`, `surface-2`, `surface-3`, `surface-muted`, `card`, `popover`, `muted`, `secondary`                                                                                                                                                                                                                                                                                     |
| Text                | `foreground`, `muted-foreground`, `card-foreground`, `popover-foreground`, `secondary-foreground`                                                                                                                                                                                                                                                                                                                                |
| Accent and controls | `primary`, `primary-foreground`, `accent`, `accent-foreground`, `nav-active`, `link`, `button-primary`, `button-primary-foreground`, `ring`, `border`, `input`, `scrollbar-thumb`, `scrollbar-track`, `destructive`, `warning`                                                                                                                                                                                                   |
| Editor              | `editor-line-number`, `editor-line-number-active`, `tree-folder`                                                                                                                                                                                                                                                                                                                                                                 |
| Git                 | `vcs-modified` (light), `vcs-untracked` (light), `ref-head`, `ref-local`, `ref-remote`, `ref-tag`, `ref-head-bg` (light), `ref-local-bg` (light), `ref-remote-bg` (light), `ref-tag-bg` (light), `branch-1` … `branch-6`                                                                                                                                                                                                         |
| Diff                | `diff-add-bg`, `diff-add-inline-bg`, `diff-add-gutter`, `diff-add-text`, `diff-add-connector-fill` (light), `diff-add-connector-edge` (light), `diff-del-bg`, `diff-del-inline-bg`, `diff-del-gutter`, `diff-del-text`, `diff-del-connector-fill` (light), `diff-del-connector-edge` (light), `diff-modify-bg`, `diff-modify-gutter`, `diff-modify-text`, `diff-gutter-border`, `diff-collapse-line`, `diff-collapse-line-hover` |
| Comments            | `comment-bg`, `comment-bg-resolved`, `comment-marker`, `comment-edge` (light), `comment-stripe`, `comment-stripe-resolved`                                                                                                                                                                                                                                                                                                       |

The names in `syntax`: `text` (text and variables), `comment`, `keyword`, `operator`, `string`, `escape` (escapes and template expressions), `regexp`, `constant` (numbers and constants), `type`, `function`, `property`, `self` (`this`, `self` and `cls`), `decorator` (decorators and annotations), `tag` and `attribute` (markup tags and attributes), `punctuation`, `heading`, `inlineCode` and `link` (markdown headings, inline code and links).

Loxel ignores names it doesn't know and colors it can't use, and says which when you import the file.
