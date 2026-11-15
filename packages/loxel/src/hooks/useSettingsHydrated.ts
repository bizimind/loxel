import { useSyncExternalStore } from "react";

import { useSettingsStore } from "@/store/settings-store";

function subscribeSettingsHydration(onChange: () => void): () => void {
  return useSettingsStore.persist.onFinishHydration(onChange);
}

function getSettingsHydrated(): boolean {
  return useSettingsStore.persist.hasHydrated();
}

/** Whether the settings have loaded from the server: until then they are the defaults. */
export function useSettingsHydrated(): boolean {
  return useSyncExternalStore(subscribeSettingsHydration, getSettingsHydrated);
}
