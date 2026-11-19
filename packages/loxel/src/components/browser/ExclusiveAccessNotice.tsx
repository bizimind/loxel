import { MaximizeIcon, MousePointer2Icon } from "lucide-react";
import { type RefObject, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  type ExclusiveAccessNotice as Notice,
  parseExclusiveAccessNotice,
} from "@/electron/exclusive-access-notice";

import { hostOf } from "./BrowserBookmarks";

/** How long a notice stays up, as long as Chrome's. */
export const NOTICE_MS = 4_000;

/** A notice and the count of its showing, so showing the same notice again restarts it. */
interface Showing {
  notice: Notice;
  count: number;
}

// The window's notices, by webview webContents ID. Every browser panel reads this one store, so the
// window holds a single IPC subscription however many panels are open. Each notice's countdown is
// the store's, so a panel that remounts doesn't show it again.
const showing = new Map<number, Showing>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let unsubscribeIpc: (() => void) | undefined;
let shownCount = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  unsubscribeIpc ??= window.electronAPI?.onExclusiveAccessNotice(
    (payload) => {
      const notice = parseExclusiveAccessNotice(payload);
      if (!notice) return;
      const { webContentsId } = notice;
      shownCount += 1;
      showing.set(webContentsId, { notice, count: shownCount });
      clearTimeout(timers.get(webContentsId));
      timers.set(
        webContentsId,
        setTimeout(() => dismiss(webContentsId), NOTICE_MS),
      );
      notify();
    },
    (webContentsId) => {
      if (typeof webContentsId === "number") dismiss(webContentsId);
    },
  );
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    unsubscribeIpc?.();
    unsubscribeIpc = undefined;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    showing.clear();
  };
}

function dismiss(webContentsId: number): void {
  clearTimeout(timers.get(webContentsId));
  timers.delete(webContentsId);
  if (showing.delete(webContentsId)) notify();
}

/**
 * Says which site took the screen or the pointer, and how to give it back, each time a browser
 * panel's page goes fullscreen or locks the pointer, for a few seconds, like Chrome's bubble. It is
 * Loxel's own, drawn over the page in the top layer, where a fullscreen page can't cover it.
 */
export function ExclusiveAccessNotice({
  webContentsId,
  webviewRef,
}: {
  webContentsId: number | null;
  /** The panel's webview: while it is the window's fullscreen element, the page fills the window. */
  webviewRef: RefObject<HTMLElement | null>;
}) {
  const entry = useSyncExternalStore(subscribe, () =>
    webContentsId === null ? null : (showing.get(webContentsId) ?? null),
  );
  if (!entry) return null;
  // Keyed by showing, so every entry goes back on top.
  return <NoticeBubble key={entry.count} entry={entry} webviewRef={webviewRef} />;
}

function NoticeBubble({
  entry,
  webviewRef,
}: {
  entry: Showing;
  webviewRef: RefObject<HTMLElement | null>;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [fillsWindow, setFillsWindow] = useState(false);

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    // The top layer stacks in the order elements enter it, and the webview's frame may enter it
    // after this notice (the window renderer applies fullscreen on its own schedule), so the notice
    // goes back on top on every fullscreen change while it is up.
    const raise = () => {
      popover.hidePopover();
      popover.showPopover();
      setFillsWindow(
        webviewRef.current !== null && document.fullscreenElement === webviewRef.current,
      );
    };
    raise();
    document.addEventListener("fullscreenchange", raise);
    return () => document.removeEventListener("fullscreenchange", raise);
  }, [webviewRef]);

  const { origin, fullscreen, pointerLock, webContentsId } = entry.notice;
  const anchorName = `--exclusive-access-${webContentsId}`;
  const Icon = fullscreen ? MaximizeIcon : MousePointer2Icon;
  let what = "has hidden your pointer.";
  if (fullscreen)
    what = pointerLock ? "is now full screen and has hidden your pointer." : "is now full screen.";
  return (
    // The page area, which the notice is placed over unless the page fills the window. A frame
    // inside the page that goes fullscreen fills only the page area.
    <div className="pointer-events-none absolute inset-0" style={{ anchorName }}>
      <div
        ref={popoverRef}
        popover="manual"
        role="status"
        // Placed by hand: the top layer ignores the page area's position. Kept within the area, so
        // nothing of it is cut off at the window's edge.
        style={
          fillsWindow
            ? { top: "1rem", left: "50%", maxWidth: "calc(100vw - 2rem)" }
            : {
                positionAnchor: anchorName,
                top: "calc(anchor(top) + 1rem)",
                left: "anchor(center)",
                maxWidth: "calc(anchor-size(width) - 2rem)",
              }
        }
        className="animate-in fade-in bg-popover border-border text-foreground pointer-events-none fixed inset-auto m-0 flex -translate-x-1/2 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-xs shadow-lg"
      >
        <Icon className="text-muted-foreground size-3.5 shrink-0" />
        {/* Never truncated: the end of a host is the part that says whose it is. */}
        <span className="min-w-0 wrap-anywhere">
          <span className="font-medium">{hostOf(origin)}</span> {what}
        </span>{" "}
        <span className="text-muted-foreground shrink-0">
          Press{" "}
          <kbd className="bg-muted border-border text-foreground rounded border px-1.5 py-0.5 font-sans text-[10px]">
            Esc
          </kbd>{" "}
          {fullscreen ? "to exit." : "to show it."}
        </span>
      </div>
    </div>
  );
}
