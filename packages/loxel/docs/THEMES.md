# Themes

How color themes work: the theme model and its storage, how a theme reaches the page (UI tokens), terminals, and highlighted code (Monaco and Shiki), the theme.json format, and the import of other terminals' ANSI colors. User-facing behavior is on the site's Themes page.

## Model

[loxel-theme.ts](../src/lib/loxel-theme.ts) owns the model. A `LoxelTheme` is one appearance: a `base` (`light` or `dark`, which is also the mode it is used in) and three sparse override maps over that base:

- `colors`: UI tokens, the CSS custom properties of [index.css](../src/index.css), named without `--`. `UI_TOKENS` lists the color tokens a theme may set, grouped for the editor; lengths and shadows (`--radius`, `--shadow-*`, `--text-shadow`) are not part of a theme. Tokens only the light base draws (`lightOnly`) are not offered for dark themes.
- `terminal`: the terminal's foreground, cursor, selection and 16 ANSI colors. The built-in palettes live here (`BASE_TERMINAL`) rather than in CSS, since nothing else reads them. There is no terminal background: the terminal always draws on the theme's `editor-surface`.
- `syntax`: colors by role (`SYNTAX_ROLES`), each a group of TextMate scopes and language-server semantic token types that the Loxel themes color alike.

`BUILTIN_THEMES` are Loxel Light and Loxel Dark, with empty overrides: their colors are index.css's, [loxel-themes.ts](../src/lib/loxel-themes.ts)' and `BASE_TERMINAL`'s. Overrides stay sparse so a custom theme, and a theme.json file, keeps working as Loxel adds or retunes colors.

The settings store's `themes` holds the chosen id per mode and the custom themes (`ThemeSettings`). `resolveTheme` picks a mode's theme and falls back to the mode's built-in when the id names no theme of that base. The store's actions keep the invariants: built-ins never change (`updateTheme` ignores them), duplicating and importing select the new theme for its mode, an import with the name and base of a custom theme replaces it in place (same id, so a mode using it restyles), a name that matches a built-in gets " (imported)", and removing a theme puts a mode that used it back on its built-in. The Settings modal's Cancel snapshot includes `themes`.

Theme colors are written into a stylesheet, so `isThemeColor` admits only hex, color functions with numeric arguments and a few keywords, nothing that could close a declaration, and in the renderer only what `CSS.supports` reads as a color. `parseThemeSettings` applies it to stored and synced settings (via `withValidSettings` in [settings-store.ts](../src/store/settings-store.ts)) and returns valid settings as the same object, so a synced update that leaves the themes alone restyles nothing.

## UI colors

[theme-stylesheet.ts](../src/lib/theme-stylesheet.ts) turns the two chosen themes into a `<style id="loxel-theme">`: the light theme's overrides under `:root:not(.dark), .light`, the dark theme's under `.dark`, each with one more class's specificity than index.css, so the overrides win wherever the base's tokens apply, `.light` and `.dark` subtrees included. `useThemeSync` applies it when the settings load or the themes change. The CSS is cached in localStorage and index.html's inline script injects it before first paint, as it does the mode, so a custom theme does not flash its base's colors at launch.

`readThemeTokens` resolves any theme's token values, applied or not: a hidden probe element carries the theme's base class and its overrides as inline custom properties, and the stylesheet's selectors skip it (`[data-theme-probe]`). The theme editor's values and previews, the terminal background and Monaco's chrome colors all read through it, which also keeps them independent of effect order (a child's effects run before `useThemeSync` restyles the page).

## Terminals

[Terminal.tsx](../src/components/terminal/Terminal.tsx) resolves the mode's theme, reads its `editor-surface` with `readThemeTokens` and builds the xterm options with `xtermColorOptions`: the theme's terminal colors over its base's, background and cursor accent on the surface, and a minimum contrast ratio of 4.5 for light themes and 1 for dark ones. Colors xterm does not parse itself (anything but hex and comma `rgba()`) are converted to hex first, which keeps their alpha. See [TERMINALS.md](TERMINALS.md#colors).

## Highlighted code

[syntax-theme.ts](../src/lib/syntax-theme.ts) builds a theme's syntax colors: its base's TextMate theme with the overridden roles' scopes taken out of the base's rules and given rules of their own, one per color and font style, each keeping the base's font style for its scopes; plus semantic token rules for Monaco. Leaving the base's rules on an overridden scope would be wrong in Monaco: the bridge maps a token's color and style back to the first rule that has them, so a base rule left on an overridden scope would pull every other token of its old color onto that scope, and an override without the base's style would match nothing. `baseSyntaxColors` reads each role's default from the base theme, by the role's first scope.

A theme with syntax colors gets a TextMate theme name of its own, from its id (`syntaxThemeName`), which stays the same across edits so the highlighter holds one theme per custom theme. `shikiToMonaco` maps token colors back to scopes from the themes loaded when it runs, so changed colors need a new bridge. [editor-themes.ts](../src/lib/editor-themes.ts) follows the settings: after a short pause in edits it loads an active theme's TextMate theme again when its syntax colors changed (a load under the same name replaces the old one; it then sets another theme in Shiki, which skips `setTheme` for the theme it set last), re-bridges ([monaco-env.ts](../src/lib/monaco-env.ts) restores Monaco's own `setTheme` and `create` first, so the bridge's wrappers are replaced rather than nested), redefines the Monaco themes with the chrome colors of [monaco-theme.ts](../src/lib/monaco-theme.ts) and the role's semantic rules, and publishes the names in `useSyntaxThemeStore`, with a `revision` that counts reloads, only when one of them changed. Monaco takes unscoped text from `editor.foreground`, so the `text` role sets that chrome color too.

`getMonacoThemeName`, `useReadOnlyCodeTheme` (diff hunks, file previews, log context, which rerun on a new name or revision) and markdown code blocks ([code-block-highlight.ts](../src/components/editor/code-block-highlight.ts), which repaint on any change to the store) read their names from that store. Read-only code in dark mode stays on github-dark unless the dark theme sets syntax colors.

## theme.json

[theme-file.ts](../src/lib/theme-file.ts) serializes a theme as `{ loxelTheme: 1, name, base, colors, terminal, syntax }`, without its id, and parses files back. Parsing rejects files that are not version 1 themes with a base, keeps only known names with valid colors, and reports the rest as `ignored`, which the import shows. Export goes through `downloadTextFile` ([download-file.ts](../src/lib/download-file.ts)), which the desktop app turns into a save dialog. The format is documented for users on the site's Themes page.

## Other terminals' ANSI colors

[terminal-scheme-import.ts](../src/lib/terminal-scheme-import.ts) reads the 16 ANSI colors of iTerm2 `.itermcolors` files (an XML property list, through `DOMParser`), Windows Terminal schemes and VS Code themes or `settings.json` (`workbench.colorCustomizations`, each `[Theme]` scope applied over the unscoped colors, as VS Code does), through `jsonc-parser`. The format is told apart by content, not extension. A profile with iTerm2's separate light and dark colors yields one scheme per mode, and its stale plain keys are ignored then; P3 colors are converted to sRGB. A file keeps its schemes with all 16 colors and lists why it skipped the others; it throws `SchemeImportError` only when none is usable. Backgrounds, foregrounds and cursors are not read: the theme editor takes a scheme's ANSI colors into the edited theme (for a light and dark iTerm2 profile, the one of the theme's mode), which keeps its own surfaces.
