import { useEffect } from "react";

import { useUIStore } from "@/store/ui";

/** Sync the `dark` class on `<html>` with the UI store's darkMode state. */
export function useThemeSync(): void {
  const darkMode = useUIStore((s) => s.darkMode);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);
}
