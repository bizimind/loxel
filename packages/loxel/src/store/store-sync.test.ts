import { describe, expect, jest, test } from "bun:test";

import { useSettingsStore } from "./settings-store";
import { applyStoreUpdate } from "./store-sync";
import { useUIStore } from "./ui";

describe("applyStoreUpdate", () => {
  test("settings: an update matching the persisted slice is a no-op", () => {
    const { partialize } = useSettingsStore.persist.getOptions();
    const persisted = partialize?.(useSettingsStore.getState());
    const listener = jest.fn();
    const unsubscribe = useSettingsStore.subscribe(listener);

    // A sync target that omits a persisted field never reconciles, so windows echo writes forever.
    applyStoreUpdate("settings", JSON.parse(JSON.stringify(persisted)));

    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });

  test("settings: a synced theme is applied, and an unknown one falls back to dark", () => {
    applyStoreUpdate("settings", { theme: "light" });
    expect(useSettingsStore.getState().theme).toBe("light");
    applyStoreUpdate("settings", { theme: "sepia" });
    expect(useSettingsStore.getState().theme).toBe("dark");
  });

  test("settings: synced color schemes are checked, and kept as is when only the theme changes", () => {
    const { terminal } = useSettingsStore.getState();
    applyStoreUpdate("settings", { terminal: { ...terminal, colorSchemes: { light: 1 } } });
    const { colorSchemes } = useSettingsStore.getState().terminal;
    expect(colorSchemes).toEqual({ light: "loxel-light", dark: "loxel-dark", imported: [] });

    const persisted = useSettingsStore.persist
      .getOptions()
      .partialize?.(useSettingsStore.getState());
    applyStoreUpdate("settings", { ...JSON.parse(JSON.stringify(persisted)), theme: "light" });
    expect(useSettingsStore.getState().terminal.colorSchemes).toBe(colorSchemes);
  });

  test("ui: darkMode from an older window is ignored", () => {
    useUIStore.setState({ darkMode: false });
    applyStoreUpdate("ui", { darkMode: true, diffViewMode: "unified" });
    expect(useUIStore.getState().darkMode).toBe(false);
    expect(useUIStore.getState().diffViewMode).toBe("unified");
  });
});
