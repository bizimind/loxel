import { createDekSource } from "./dek-source";

export async function loadOrCreateKey(): Promise<Buffer> {
  return createDekSource().loadKey();
}
