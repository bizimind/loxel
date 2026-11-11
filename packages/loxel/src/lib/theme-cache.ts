/**
 * The last resolved theme, kept in localStorage so the next launch paints in it before the
 * settings load from the server. index.html's inline script reads the same key before first paint;
 * keep the two in step.
 */
const DARK_MODE_CACHE_KEY = "loxel-dark-mode";

/** The theme the last session resolved; dark (the default theme) when none is cached. */
export function readCachedDarkMode(): boolean {
  try {
    return localStorage.getItem(DARK_MODE_CACHE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function cacheDarkMode(darkMode: boolean): void {
  try {
    localStorage.setItem(DARK_MODE_CACHE_KEY, String(darkMode));
  } catch {
    // Storage unavailable: the next launch paints dark until the settings load.
  }
}
