import { decrypt, encrypt, isEncrypted } from "./secret-store";

/**
 * Store keys whose persisted state holds model API keys (`state.models[].apiKey`). The route
 * layer encrypts those fields at rest and decrypts them on read. The settings store persists
 * under the bare key `settings` (see `createServerStorage("settings")` in
 * `src/store/server-storage.ts`); the `-settings` suffix is kept for stores that follow the
 * same convention.
 */
export function isEncryptedStoreKey(storeKey: string): boolean {
  return storeKey === "settings" || storeKey.endsWith("-settings");
}

function forEachModelKey(
  jsonStr: string,
  visit: (apiKey: string) => string | { err: string } | undefined,
): { json: string; touched: boolean } {
  const parsed: unknown = JSON.parse(jsonStr);
  if (typeof parsed !== "object" || parsed === null) return { json: jsonStr, touched: false };
  const state = (parsed as Record<string, unknown>).state;
  if (typeof state !== "object" || state === null) return { json: jsonStr, touched: false };
  const models = (state as Record<string, unknown>).models;
  if (!Array.isArray(models)) return { json: jsonStr, touched: false };
  let touched = false;
  for (const model of models) {
    if (
      typeof model === "object" &&
      model !== null &&
      typeof model.apiKey === "string" &&
      model.apiKey
    ) {
      const next = visit(model.apiKey);
      if (next !== undefined) {
        model.apiKey = next;
        touched = true;
      }
    }
  }
  return { json: touched ? JSON.stringify(parsed) : jsonStr, touched };
}

/** True when at least one non-empty `apiKey` in the persisted state is not encrypted. */
export function hasPlaintextModelKeys(jsonStr: string): boolean {
  let found = false;
  forEachModelKey(jsonStr, (v) => {
    if (!isEncrypted(v)) found = true;
    return undefined;
  });
  return found;
}

/** Encrypt every plaintext `apiKey`; already-encrypted values are left untouched. */
export function encryptModelKeys(jsonStr: string): string {
  return forEachModelKey(jsonStr, (v) => (isEncrypted(v) ? undefined : encrypt(v))).json;
}

/**
 * Decrypt every `apiKey`. A value that cannot be decrypted (for example after the data
 * encryption key changed) becomes `{ err }`, which the renderer types as `ApiKeyError`.
 */
export function decryptModelKeys(jsonStr: string): string {
  return forEachModelKey(jsonStr, (v) => {
    try {
      return decrypt(v);
    } catch {
      return { err: "Decryption failed (encryption key changed)" };
    }
  }).json;
}
