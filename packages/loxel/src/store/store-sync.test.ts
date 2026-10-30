import { describe, expect, jest, test } from "bun:test";

import { useSettingsStore } from "./settings-store";
import { applyStoreUpdate } from "./store-sync";

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
});
