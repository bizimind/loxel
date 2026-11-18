/**
 * Focus moving into a `<webview>` (a browser panel's page) fires no focus or focusin event in the
 * host document, so code that follows focus learns of it here instead.
 */

/**
 * Call `callback` each time focus moves into a `<webview>`. The main process reports it (the
 * guest's webContents focus event), which also covers clicking into a page from another app or
 * from another page, when this window has no focus left to lose. As a fallback, this window blurs
 * and the webview is the active element a tick later. Returns an unsubscribe function.
 */
export function onWebviewFocus(callback: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onWindowBlur = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.activeElement?.tagName === "WEBVIEW") callback();
    }, 0);
  };
  const offWebviewFocused = window.electronAPI?.onWebviewFocused(callback);
  window.addEventListener("blur", onWindowBlur);
  return () => {
    offWebviewFocused?.();
    window.removeEventListener("blur", onWindowBlur);
    clearTimeout(timer);
  };
}
