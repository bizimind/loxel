/**
 * Orchestrates schema synchronization between the settings store,
 * Monaco's JSON language service, and the YAML language server.
 *
 * Called on initial load (after settings hydrate) and on settings save.
 */
import * as api from "@/api/client";
import { selectEffectiveSchemas, useSettingsStore } from "@/store/settings-store";

import { frontendLog } from "./frontend-logger";
import { setConfiguredSchemas } from "./json-schema-registry";

const log = frontendLog.child("ui");

let syncing = false;
let pendingSync = false;

/** Fetch all configured schemas from the server and apply to Monaco + YAML LSP. */
export async function syncSchemas(): Promise<void> {
  if (syncing) {
    pendingSync = true;
    return;
  }
  syncing = true;

  try {
    const schemas = selectEffectiveSchemas(useSettingsStore.getState());
    const enabled = schemas.filter((s) => s.enabled);

    const result = await api.syncSchemas(enabled.map((s) => ({ glob: s.glob, url: s.url })));

    // Apply resolved JSON schemas to Monaco (skip failed resolutions)
    setConfiguredSchemas(
      result.json.filter((s): s is typeof s & { schema: unknown } => s.schema !== null),
    );
  } catch (err) {
    log.error("Schema sync failed", { error: err instanceof Error ? err : undefined });
  } finally {
    syncing = false;
    if (pendingSync) {
      pendingSync = false;
      syncSchemas();
    }
  }
}

/** Initialize schema sync — call once at module load time. */
export function initSchemaSync(): void {
  // Wait for settings store to hydrate from localStorage, then sync
  if (useSettingsStore.persist.hasHydrated()) {
    syncSchemas();
  } else {
    useSettingsStore.persist.onFinishHydration(() => {
      syncSchemas();
    });
  }
}
