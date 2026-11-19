/**
 * Electron's `nativeTheme` follows Loxel's Theme setting, so native UI (menus, dialogs), browser
 * panels' `prefers-color-scheme` and window backgrounds match the app instead of the OS. The
 * renderer reports each change of the setting (`SET_THEME_SOURCE`); before any window exists,
 * main reads the persisted setting so the first window already opens in it.
 */
import { nativeTheme } from "electron";

import { asThemePreference } from "../lib/theme-preference";
import { persistedTheme } from "../server/persisted-settings";
import { appWindowList, onAppWindowMessage } from "./app-windows";
import { SET_THEME_SOURCE } from "./ipc-channels";

/** The renderer's `--background` in each theme (`src/index.css`); keep the two in step. */
const WINDOW_BACKGROUND = { dark: "#191a1c", light: "#ffffff" } as const;

/** The background a window paints before (and behind) its page, in the current theme. */
export function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

/** Apply each theme setting a window's renderer reports, and repaint window backgrounds. */
export function installNativeTheme(): void {
  onAppWindowMessage(SET_THEME_SOURCE, (_event, theme: unknown) => {
    const source = asThemePreference(theme);
    if (source) nativeTheme.themeSource = source;
  });
  nativeTheme.on("updated", () => {
    // Loxel's own windows: a browser panel popup paints its page's background.
    for (const win of appWindowList()) win.setBackgroundColor(windowBackgroundColor());
  });
}

/**
 * Apply the persisted theme setting (the settings row, `readLaunchSettings`) before the first
 * window opens. Without it, the OS appearance stays in effect until the window's renderer reports
 * the setting.
 */
export function applyPersistedTheme(raw: string | null): void {
  nativeTheme.themeSource = persistedTheme(raw);
}
