import { describe, expect, jest, test } from "bun:test";

import { localServerId } from "@/api/local-server";
import { toServerId } from "@/api/worktree-ref";

import { useProjectStore } from "./projects";
import { useSettingsStore } from "./settings-store";
import { applyStoreUpdate } from "./store-sync";
import { useUIStore } from "./ui";

function persistedSlice() {
  return useSettingsStore.persist.getOptions().partialize?.(useSettingsStore.getState());
}

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

  test("settings: synced themes are checked, and kept as is when only the mode changes", () => {
    applyStoreUpdate("settings", {
      ...JSON.parse(JSON.stringify(persistedSlice())),
      themes: { light: 1 },
    });
    const { themes } = useSettingsStore.getState();
    expect(themes).toEqual({ light: "loxel-light", dark: "loxel-dark", custom: [] });

    applyStoreUpdate("settings", {
      ...JSON.parse(JSON.stringify(persistedSlice())),
      theme: "light",
    });
    expect(useSettingsStore.getState().themes).toBe(themes);
  });

  test("projects: another tab's expanded projects keep this window's other servers' ones", () => {
    const listed = (id: string, server: ReturnType<typeof localServerId>) =>
      ({ id, path: `/${id}`, server }) as never;
    useProjectStore.setState({
      projects: [listed("here", localServerId()), listed("there", toServerId("other-server"))],
      expandedProjectIds: ["there"],
    });

    applyStoreUpdate("projects", { expandedProjectIds: ["here"] });

    expect(useProjectStore.getState().expandedProjectIds).toEqual(["here", "there"]);
    useProjectStore.setState({ projects: [], expandedProjectIds: [] });
  });

  test("ui: darkMode from an older window is ignored", () => {
    useUIStore.setState({ darkMode: false });
    applyStoreUpdate("ui", { darkMode: true, diffViewMode: "unified" });
    expect(useUIStore.getState().darkMode).toBe(false);
    expect(useUIStore.getState().diffViewMode).toBe("unified");
  });
});
