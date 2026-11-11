import { z } from "zod";

import { SETTINGS_STORE_KEY } from "../server/persisted-settings";

const StoreRowSchema = z.object({ value: z.string().nullable() });

/** The persisted settings row (see `persisted-settings.ts`), read from the server that stores it. */
export async function readSettingsRow(
  serverUrl: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await fetch(`${serverUrl}/api/stores/${SETTINGS_STORE_KEY}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return StoreRowSchema.parse(await res.json()).value;
}
