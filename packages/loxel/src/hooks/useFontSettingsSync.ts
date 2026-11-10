import { useLayoutEffect } from "react";

import { fontCssVariables } from "@/lib/font-settings";
import { useSettingsStore } from "@/store/settings-store";

/** Set the font CSS variables on `<html>` from the font settings, before the first paint. */
export function useFontSettingsSync(): void {
  const fonts = useSettingsStore((s) => s.fonts);
  useLayoutEffect(() => {
    const { style } = document.documentElement;
    for (const [name, value] of Object.entries(fontCssVariables(fonts))) {
      style.setProperty(name, value);
    }
  }, [fonts]);
}
