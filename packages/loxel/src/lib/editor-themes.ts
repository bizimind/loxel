/**
 * Keeps the editors' syntax and chrome colors on the chosen themes: loads a theme's syntax colors
 * into the highlighter as its own TextMate theme (again, under the same name, when they change),
 * re-bridges the highlighter into Monaco after a load (`bridge`, from monaco-env.ts), redefines
 * the Monaco themes and points highlighted code at them (`useSyntaxThemeStore`).
 */
import * as monaco from "monaco-editor";
import type { Highlighter } from "shiki";

import { useSettingsStore } from "@/store/settings-store";
import { useUIStore } from "@/store/ui";

import { toHexColor } from "./css-color";
import { frontendLog } from "./frontend-logger";
import { BUILTIN_THEMES, type LoxelTheme, resolveTheme } from "./loxel-theme";
import { enhanceMonacoThemes, getMonacoThemeName } from "./monaco-theme";
import {
  BASE_TEXTMATE,
  syntaxTextmateTheme,
  syntaxThemeName,
  syntaxThemeNames,
  useSyntaxThemeStore,
} from "./syntax-theme";

const log = frontendLog.child("ui");

/** Color edits arrive per keystroke or picker drag; restyle the editors once they pause. */
const APPLY_DELAY_MS = 150;

const BUILTIN_TEXTMATE_NAMES = new Set(
  Object.values(BASE_TEXTMATE).map((theme) => theme.name ?? ""),
);

/** The syntax colors each custom TextMate theme name was last loaded with. */
const loadedSyntax = new Map<string, string>();

async function applyEditorThemes(
  highlighter: Highlighter,
  bridge: (highlighter: Highlighter) => void,
): Promise<void> {
  const { themes } = useSettingsStore.getState();
  const active: LoxelTheme[] = [resolveTheme(themes, false), resolveTheme(themes, true)];
  let reloaded = false;
  for (const theme of active) {
    const name = syntaxThemeName(theme);
    // Built-in TextMate themes load with the highlighter and never change.
    if (BUILTIN_TEXTMATE_NAMES.has(name)) continue;
    const signature = JSON.stringify(theme.syntax);
    if (loadedSyntax.get(name) === signature) continue;
    // A theme loaded again under its name replaces the old one.
    await highlighter.loadTheme(syntaxTextmateTheme(theme, toHexColor));
    loadedSyntax.set(name, signature);
    reloaded = true;
  }
  if (reloaded) {
    // Shiki skips `setTheme` for the theme it set last, which may be the old one by this name.
    highlighter.setTheme(BASE_TEXTMATE.dark.name ?? "loxel-dark");
    // Bridging redefines every loaded theme from its TextMate colors alone, built-ins included.
    bridge(highlighter);
  }
  enhanceMonacoThemes(highlighter, reloaded ? [...BUILTIN_THEMES, ...active] : active);
  const [light, dark] = active as [LoxelTheme, LoxelTheme];
  const names = syntaxThemeNames(light, dark);
  const current = useSyntaxThemeStore.getState();
  if (
    reloaded ||
    names.light !== current.light ||
    names.dark !== current.dark ||
    names.readOnlyDark !== current.readOnlyDark
  ) {
    useSyntaxThemeStore.setState({ ...names, revision: current.revision + (reloaded ? 1 : 0) });
  }
  monaco.editor.setTheme(getMonacoThemeName(useUIStore.getState().darkMode));
}

/** Follow the theme settings from now on, applying them once now. */
export function followEditorThemes(
  highlighter: Highlighter,
  bridge: (highlighter: Highlighter) => void,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const apply = () => {
    applyEditorThemes(highlighter, bridge).catch((error: unknown) => {
      log.error("Could not apply the editor themes", { error });
    });
  };
  useSettingsStore.subscribe((state, previous) => {
    if (state.themes === previous.themes) return;
    clearTimeout(timer);
    timer = setTimeout(apply, APPLY_DELAY_MS);
  });
  apply();
}
