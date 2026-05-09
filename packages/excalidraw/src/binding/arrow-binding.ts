import type { ExcalidrawElement } from "../elements/excalidraw-types.ts";

/**
 * Remove references to a deleted element from all boundElements arrays and arrow bindings.
 * Arrow creation and binding is handled natively by @excalidraw/element's
 * convertToExcalidrawElements — this module only handles cleanup on deletion.
 */
export function cleanupBindings(elements: ExcalidrawElement[], deletedId: string): void {
  for (const el of elements) {
    if (el.isDeleted) continue;

    // Clean boundElements arrays
    const bound = el.boundElements as Array<{ id: string; type: string }> | null;
    if (bound) {
      el.boundElements = bound.filter((b) => b.id !== deletedId);
    }

    // Clean arrow bindings
    if (el.type === "arrow") {
      const startBinding = el.startBinding as { elementId: string } | null;
      if (startBinding?.elementId === deletedId) {
        el.startBinding = null;
      }
      const endBinding = el.endBinding as { elementId: string } | null;
      if (endBinding?.elementId === deletedId) {
        el.endBinding = null;
      }
    }

    // Clean text container references
    if (el.type === "text" && el.containerId === deletedId) {
      el.containerId = null;
    }
  }
}
