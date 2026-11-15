import { createDekSource } from "./dek-source";

/** The data encryption key, or null when its source has none to give. */
export async function loadOrCreateKey(): Promise<Buffer | null> {
  return createDekSource().loadKey();
}
