import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  // A zoom change resizes the viewport in CSS px, so `resize` fires on every zoom step.
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

// `getZoomFactor` is optional: an in-app update ships a newer renderer with the older
// app bundle's preload, which may not expose it.
const getZoomFactor = () => window.electronAPI?.getZoomFactor?.() ?? 1;

/**
 * Tracks the Electron page zoom factor (Cmd+/Cmd-). Page zoom scales CSS `px` too, so
 * elements that must line up with native chrome (e.g. the macOS traffic lights) divide
 * their sizes by this factor. Always 1 outside Electron.
 */
export function useZoomFactor(): number {
  return useSyncExternalStore(subscribe, getZoomFactor);
}
