import { type RefObject, useEffect } from "react";

/** A ring pulsing twice around the panel's prompts. */
const NUDGE_KEYFRAMES: Keyframe[] = [
  { boxShadow: "inset 0 0 0 2px var(--color-primary)" },
  { boxShadow: "inset 0 0 0 2px transparent" },
];
const NUDGE_OPTIONS: KeyframeAnimationOptions = { duration: 400, iterations: 2 };

// The window's panels waiting for nudges, by webview webContents ID: one IPC subscription for all.
const nudgers = new Map<number, Set<() => void>>();
let unsubscribeIpc: (() => void) | undefined;

function listen(webContentsId: number, nudge: () => void): () => void {
  unsubscribeIpc ??= window.electronAPI?.onExclusiveAccessRefused((id) => {
    if (typeof id !== "number") return;
    for (const nudger of nudgers.get(id) ?? []) nudger();
  });
  const panel = nudgers.get(webContentsId) ?? new Set();
  nudgers.set(webContentsId, panel);
  panel.add(nudge);
  return () => {
    panel.delete(nudge);
    if (panel.size === 0) nudgers.delete(webContentsId);
    if (nudgers.size > 0) return;
    unsubscribeIpc?.();
    unsubscribeIpc = undefined;
  };
}

/**
 * Highlight the prompts in `promptsRef` when main says the page of webview `webContentsId` was
 * refused fullscreen or pointer lock because a prompt holds it, so the user sees why the video
 * didn't go fullscreen: answering the prompt lets the page ask again.
 */
export function usePromptNudge(
  webContentsId: number | null,
  promptsRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (webContentsId === null) return;
    return listen(webContentsId, () => {
      // Not every DOM implementation animates (the tests' doesn't).
      promptsRef.current?.animate?.(NUDGE_KEYFRAMES, NUDGE_OPTIONS);
    });
  }, [webContentsId, promptsRef]);
}
