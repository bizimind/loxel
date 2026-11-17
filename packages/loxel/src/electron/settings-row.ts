import { z } from "zod";

import { SETTINGS_STORE_KEY } from "../server/persisted-settings";
import { serverFetch } from "./app-server";

const StoreRowSchema = z.object({ value: z.string().nullable() });

/** How long launch waits for the settings before opening the first window without them. */
const LAUNCH_SETTINGS_TIMEOUT_MS = 2000;

/**
 * The persisted settings row for the settings main applies at launch, or undefined when it cannot
 * be read in time: the first window then opens with the defaults until its renderer reports them.
 */
export async function readLaunchSettings(): Promise<string | null | undefined> {
  try {
    return await readSettingsRow(AbortSignal.timeout(LAUNCH_SETTINGS_TIMEOUT_MS));
  } catch (err) {
    console.warn(
      "[electron] Cannot read the settings; using the defaults until a window loads",
      err,
    );
    return undefined;
  }
}

/** The persisted settings row (see `persisted-settings.ts`), read from the server that stores it. */
export async function readSettingsRow(signal?: AbortSignal): Promise<string | null> {
  const res = await serverFetch(`/api/stores/${SETTINGS_STORE_KEY}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return StoreRowSchema.parse(await res.json()).value;
}
