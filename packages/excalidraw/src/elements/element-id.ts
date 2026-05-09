import type { ExcalidrawElement } from "./excalidraw-types.ts";

export function generateElementId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/** Throw if an active (non-deleted) element already uses this ID */
export function validateIdUnique(elements: readonly ExcalidrawElement[], id: string): void {
  const existing = elements.find((el) => el.id === id && !el.isDeleted);
  if (existing) {
    throw new Error(`ID already exists: ${id} (type: ${existing.type})`);
  }
}
