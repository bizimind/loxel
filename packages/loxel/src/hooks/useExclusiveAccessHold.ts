import { useEffect } from "react";

/** The window's modals that are open now; the window holds while there is any. */
let openModals = 0;

/**
 * While `open`, a Loxel modal shows over the whole window, so its browser panels' pages leave
 * fullscreen and release the pointer lock, and can take neither back until it closes (main's
 * `exclusive-access-holds.ts`). A page in fullscreen would cover the modal, and a locked pointer
 * couldn't reach it. Main hears only when the first modal opens and the last one closes.
 */
export function useExclusiveAccessHold(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    openModals++;
    if (openModals === 1) window.electronAPI?.setExclusiveAccessHold(true);
    return () => {
      openModals--;
      if (openModals === 0) window.electronAPI?.setExclusiveAccessHold(false);
    };
  }, [open]);
}
