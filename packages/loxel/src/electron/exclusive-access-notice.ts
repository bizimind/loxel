/**
 * A notice a browser panel shows when its page takes the screen or the pointer: which site it is
 * and how to leave, as Chrome's "is now full screen" bubble does. Sent from main to the window
 * hosting the page's webview; shared by both sides, so this module must stay free of Node and
 * Electron imports.
 */
export interface ExclusiveAccessNotice {
  /** The page's webview webContents ID; each browser panel shows only its own notices. */
  webContentsId: number;
  /**
   * The origin of the frame that asked, as Chromium committed it (never anything the page says
   * about itself, such as its title).
   */
  origin: string;
  /** An element of that frame is fullscreen. */
  fullscreen: boolean;
  /** That frame locked the pointer. */
  pointerLock: boolean;
}

/** Narrow an IPC payload to a notice, or null when it isn't one. */
export function parseExclusiveAccessNotice(value: unknown): ExclusiveAccessNotice | null {
  if (typeof value !== "object" || value === null) return null;
  const { webContentsId, origin, fullscreen, pointerLock } = value as Record<string, unknown>;
  if (typeof webContentsId !== "number" || typeof origin !== "string") return null;
  if (typeof fullscreen !== "boolean" || typeof pointerLock !== "boolean") return null;
  if (!fullscreen && !pointerLock) return null;
  return { webContentsId, origin, fullscreen, pointerLock };
}
