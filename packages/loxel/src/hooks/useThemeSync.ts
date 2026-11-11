import { useEffect, useSyncExternalStore } from "react";

import { cacheDarkMode } from "@/lib/theme-cache";
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
 * this keeps current.
 */
export function useThemeSync(): void {
  const theme = useSettingsStore((s) => s.theme);
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
}
