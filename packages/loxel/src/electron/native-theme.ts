/**
 * Electron's `nativeTheme` follows Loxel's Theme setting, so native UI (menus, dialogs), browser
 * panels' `prefers-color-scheme` and window backgrounds match the app instead of the OS. The
 * renderer reports each change of the setting (`SET_THEME_SOURCE`); before any window exists,
 * main reads the persisted setting so the first window already opens in it.
 */
import { type BrowserWindow, ipcMain, nativeTheme } from "electron";

import { asThemePreference } from "../lib/theme-preference";
import { persistedTheme } from "../server/persisted-settings";
import { SET_THEME_SOURCE } from "./ipc-channels";
import { readSettingsRow } from "./settings-row";

/** The renderer's `--background` in each theme (`src/index.css`); keep the two in step. */
const WINDOW_BACKGROUND = { dark: "#191a1c", light: "#ffffff" } as const;

/** The background a window paints before (and behind) its page, in the current theme. */
export function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

/** How long launch waits for the theme setting before opening the first window without it. */
const SETTINGS_READ_TIMEOUT_MS = 2000;

/** Loxel's own windows, whose background follows the theme (not browser panel popups). */
const appWindows = new Set<BrowserWindow>();

/** Keep `win`'s background in the theme as it changes, for as long as the window lives. */
export function followNativeTheme(win: BrowserWindow): void {
  appWindows.add(win);
  win.on("closed", () => appWindows.delete(win));
}

/** Apply each theme setting a window's renderer reports, and repaint window backgrounds. */
export function installNativeTheme(): void {
  ipcMain.on(SET_THEME_SOURCE, (_event, theme: unknown) => {
    const source = asThemePreference(theme);
    if (source) nativeTheme.themeSource = source;
  });
  nativeTheme.on("updated", () => {
    for (const win of appWindows) win.setBackgroundColor(windowBackgroundColor());
  });
}

/**
 * Apply the persisted theme setting, read from the server, before the first window opens. If it
 * cannot be read in time, the OS appearance stays in effect until the window's renderer reports
 * the setting.
 */
export async function applyPersistedTheme(serverUrl: string): Promise<void> {
  try {
    const raw = await readSettingsRow(serverUrl, AbortSignal.timeout(SETTINGS_READ_TIMEOUT_MS));
    nativeTheme.themeSource = persistedTheme(raw);
  } catch (err) {
    console.warn("[electron] Cannot read the theme setting; following the OS until it loads", err);
  }
}
