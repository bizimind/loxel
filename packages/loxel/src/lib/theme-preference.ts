// No `@/` imports: Electron main, whose build has no path aliases, uses this module too.

/**
 * Color theme choice; "system" follows the OS appearance. The values are also those of Electron's
 * `nativeTheme.themeSource`, which main sets from this setting.
 */
export type ThemePreference = "dark" | "light" | "system";
export const THEME_PREFERENCES: readonly ThemePreference[] = ["dark", "light", "system"];
/** How Settings and the command palette name each theme choice. */
export const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

/** `value` as a theme choice, or null when it is not one. */
export function asThemePreference(value: unknown): ThemePreference | null {
  return THEME_PREFERENCES.find((t) => t === value) ?? null;
}

/**
 * A stored theme value checked: an unknown value (missing, hand-edited, or from a newer version)
 * falls back to the default, dark.
 */
export function parseThemePreference(value: unknown): ThemePreference {
  return asThemePreference(value) ?? "dark";
}
