import { useEffect, useSyncExternalStore } from "react";

import { resolveTheme } from "@/lib/loxel-theme";
import { cacheDarkMode } from "@/lib/theme-cache";
import { applyThemeStylesheet } from "@/lib/theme-stylesheet";
import { useSettingsStore } from "@/store/settings-store";
import { useUIStore } from "@/store/ui";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeSystemDark(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSystemDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

function subscribeSettingsHydration(onChange: () => void): () => void {
  return useSettingsStore.persist.onFinishHydration(onChange);
}

function getSettingsHydrated(): boolean {
  return useSettingsStore.persist.hasHydrated();
}

/**
 * Resolve the theme setting ("system" follows the OS) into the UI store's `darkMode`, the `dark`
 * class on `<html>` and its `color-scheme`, so native controls and scrollbars match. Until the
 * settings load, the page keeps the theme index.html applied from the last session's cache, which
 * this keeps current. In Electron the setting also goes to `nativeTheme`, for native UI, browser
 * panels and window backgrounds. With an explicit theme that makes this page's own
 * `prefers-color-scheme` match the setting too, which is why only "system" reads it. The color
 * themes chosen for each mode restyle the page through their stylesheet (theme-stylesheet.ts).
 */
export function useThemeSync(): void {
  const theme = useSettingsStore((s) => s.theme);
  const themes = useSettingsStore((s) => s.themes);
  const hydrated = useSyncExternalStore(subscribeSettingsHydration, getSettingsHydrated);
  const systemDark = useSyncExternalStore(subscribeSystemDark, getSystemDark);
  const darkMode = theme === "system" ? systemDark : theme === "dark";

  useEffect(() => {
    if (!hydrated) return;
    useUIStore.setState({ darkMode });
    const root = document.documentElement;
    root.classList.toggle("dark", darkMode);
    root.style.colorScheme = darkMode ? "dark" : "light";
    cacheDarkMode(darkMode);
  }, [hydrated, darkMode]);

  useEffect(() => {
    if (!hydrated) return;
    applyThemeStylesheet(resolveTheme(themes, false), resolveTheme(themes, true));
  }, [hydrated, themes]);

  useEffect(() => {
    if (!hydrated) return;
    window.electronAPI?.setThemeSource(theme);
  }, [hydrated, theme]);
}
