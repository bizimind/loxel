import { useEffect, useSyncExternalStore } from "react";

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

/**
 * Resolve the theme setting ("system" follows the OS) into the UI store's `darkMode`, the `dark`
 * class on `<html>` and its `color-scheme`, so native controls and scrollbars match.
 */
export function useThemeSync(): void {
  const theme = useSettingsStore((s) => s.theme);
  const systemDark = useSyncExternalStore(subscribeSystemDark, getSystemDark);
  const darkMode = theme === "system" ? systemDark : theme === "dark";

  useEffect(() => {
    useUIStore.setState({ darkMode });
    const root = document.documentElement;
    root.classList.toggle("dark", darkMode);
    root.style.colorScheme = darkMode ? "dark" : "light";
  }, [darkMode]);
}
