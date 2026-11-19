/**
 * Renders the window's browser pages outside the dockview layouts, so they keep running when their
 * layout is swapped out (see `store/browser-pages.ts`). Each page sits in a fixed-position host laid
 * over the slot its browser panel renders, and is hidden while its slot is not shown: its tab is in
 * the background, or its layout (another worktree, or Home) is not mounted.
 */
import type { DockviewPanelApi } from "dockview-react";
import { GlobeIcon } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import { PanelErrorBoundary } from "@/components/dockview/panel-error-boundary";
import { isActivatedPanel } from "@/hooks/usePanelActivationFocus";
import { focusAreaProps } from "@/lib/focus-targets";
import { frontendLog } from "@/lib/frontend-logger";
import { onWebviewFocus } from "@/lib/webview-focus";
import { activeLayoutKey, layoutServer, layoutWorktree } from "@/store/active-worktree";
import { REVIEW_INTERVAL_MS, reviewBackgroundPages } from "@/store/browser-page-budget";
import {
  type BrowserPage,
  attachBrowserPage,
  detachBrowserPage,
  useBrowserPages,
} from "@/store/browser-pages";
import { activateEditorArea } from "@/store/tools-bar";

import { BrowserPanel } from "./BrowserPanel";

const log = frontendLog.child("ui");

/** Mounted once per window, above the layouts, so its pages outlive them. */
export function BrowserPagePool() {
  const pages = useBrowserPages((s) => s.pages);

  // While something is dragged in the window (a tab, a file from the tree), let it pass through the
  // pages to their slots, where dockview's drop targets see it, as over its own panel content.
  useEffect(() => {
    const root = document.documentElement;
    const start = () => root.toggleAttribute(DRAG_ATTR, true);
    const end = () => root.toggleAttribute(DRAG_ATTR, false);
    window.addEventListener("dragstart", start, true);
    window.addEventListener("dragend", end, true);
    window.addEventListener("drop", end, true);
    return () => {
      window.removeEventListener("dragstart", start, true);
      window.removeEventListener("dragend", end, true);
      window.removeEventListener("drop", end, true);
      end();
    };
  }, []);

  // Keep background pages within the Background Tabs budget.
  useEffect(() => {
    const timer = setInterval(() => {
      reviewBackgroundPages().catch((error: unknown) => {
        log.warn("Could not review background browser pages", { error: String(error) });
      });
    }, REVIEW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return Object.values(pages).map((page) => <BrowserPageHost key={page.id} page={page} />);
}

/** Set on the document element while a drag started in the window is in progress. */
const DRAG_ATTR = "data-browser-page-drag";

const BrowserPageHost = memo(function BrowserPageHost({ page }: { page: BrowserPage }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { slot } = page;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // In the background the page keeps its size, so it doesn't lay out again.
    if (slot) return trackSlot(slot.element, host);
    setVisible(host, false);
  }, [slot]);

  // Focus in the page activates its panel, its group and the editor area, as a click in dockview's
  // own panel content does: the page is laid over the layout, so dockview never sees the click.
  // Focus in its toolbar arrives as a focus event; focus moving into its <webview> doesn't.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !slot) return;
    const activate = () => {
      if (!isActivatedPanel(slot.api)) slot.api.setActive();
      activateEditorArea();
    };
    const offWebviewFocus = onWebviewFocus(() => {
      if (host.contains(document.activeElement)) activate();
    });
    host.addEventListener("focus", activate, { capture: true });
    return () => {
      offWebviewFocus();
      host.removeEventListener("focus", activate, { capture: true });
    };
  }, [slot]);

  return (
    <div
      ref={hostRef}
      className="fixed overflow-hidden [[data-browser-page-drag]_&]:pointer-events-none"
      {...focusAreaProps("center")}
    >
      <PanelErrorBoundary panelName="browser" Icon={GlobeIcon} center>
        <BrowserPanel
          url={page.initialUrl}
          panelId={page.id}
          panelApi={slot?.api ?? null}
          resumes={page.resumes}
          worktreePath={layoutWorktree(page.layoutKey)?.path ?? null}
          server={layoutServer(page.layoutKey)}
        />
      </PanelErrorBoundary>
    </div>
  );
});

/**
 * A browser panel's content in dockview: the slot its page is shown over. The page loads on `url`
 * the first time the panel is shown.
 */
export function BrowserPageSlot({ url, panelApi }: { url: string; panelApi: DockviewPanelApi }) {
  const slotRef = useRef<HTMLDivElement>(null);
  // The layout the panel is in, the one shown when it mounts.
  const [layoutKey] = useState(activeLayoutKey);

  // Layouts saved before browser panels used the "always" renderer restore with the default
  // renderer; upgrade them so a background tab's slot keeps its group's size, and its page with it.
  useEffect(() => {
    if (panelApi.renderer !== "always") panelApi.setRenderer("always");
  }, [panelApi]);

  // Only the first URL: the page navigates on its own after that.
  const urlRef = useRef(url);
  useLayoutEffect(() => {
    const element = slotRef.current;
    if (!element) return;
    attachBrowserPage(panelApi.id, {
      layoutKey,
      url: urlRef.current,
      slot: { element, api: panelApi },
    });
    return () => detachBrowserPage(panelApi.id, element);
  }, [panelApi, layoutKey]);

  return <div ref={slotRef} className="min-h-0 flex-1" />;
}

// ---------------------------------------------------------------------------
// Positioning
// ---------------------------------------------------------------------------

/** Placement functions of the shown pages. */
const placements = new Set<() => void>();
let mutationObserver: MutationObserver | null = null;

/**
 * Place every shown page. Runs from observer callbacks, which come before the next paint, so a page
 * moves in the same frame as its slot (dockview moves panel content in its own animation frame).
 */
function placeAll(): void {
  for (const place of placements) place();
}

/**
 * Re-place pages whenever anything in the window may have moved a slot without resizing it: an
 * inline style, class or `hidden` change (dockview positions, splits and hides panel content that
 * way; the sidebars resize that way) or a window resize. Only while a page is shown.
 */
function watchLayout(): () => void {
  if (!mutationObserver) {
    mutationObserver = new MutationObserver(placeAll);
    mutationObserver.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden"],
    });
    window.addEventListener("resize", placeAll);
  }
  return () => {
    if (placements.size > 0 || !mutationObserver) return;
    mutationObserver.disconnect();
    mutationObserver = null;
    window.removeEventListener("resize", placeAll);
  };
}

/** Set a style property only when it changes, so placing a page doesn't trigger another placement. */
function setStyle(host: HTMLElement, property: "left" | "top" | "width" | "height", px: number) {
  const value = `${px}px`;
  if (host.style[property] !== value) host.style[property] = value;
}

/**
 * Show or hide a page's host. `visibility: hidden` also hides the page to Chromium, as a
 * background tab: it reports `document.visibilityState` "hidden" and gets background throttling,
 * and it keeps its size. Hiding it with opacity would leave it "visible".
 */
function setVisible(host: HTMLElement, visible: boolean): void {
  const value = visible ? "" : "hidden";
  if (host.style.visibility === value) return;
  // A hidden page must not keep keyboard focus, or typing would go on reaching it.
  if (
    !visible &&
    document.activeElement instanceof HTMLElement &&
    host.contains(document.activeElement)
  ) {
    document.activeElement.blur();
  }
  host.style.visibility = value;
}

/**
 * The stacking level of the layer `slot` is in (its nearest positioned ancestor with a z-index),
 * so a page in a floating group stays above the docked ones as its slot does.
 */
function stackingLevel(slot: HTMLElement): string {
  for (let el = slot.parentElement; el; el = el.parentElement) {
    const { zIndex, position } = getComputedStyle(el);
    if (zIndex !== "auto" && position !== "static") return zIndex;
  }
  return "auto";
}

/** Keep `host` laid over `slot`, and shown only while `slot` is. Returns a stop function. */
function trackSlot(slot: HTMLElement, host: HTMLElement): () => void {
  const place = () => {
    const rect = slot.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setStyle(host, "left", rect.left);
      setStyle(host, "top", rect.top);
      setStyle(host, "width", rect.width);
      setStyle(host, "height", rect.height);
      const zIndex = stackingLevel(slot);
      if (host.style.zIndex !== zIndex) host.style.zIndex = zIndex;
    }
    setVisible(
      host,
      rect.width > 0 && rect.height > 0 && slot.checkVisibility({ visibilityProperty: true }),
    );
  };
  placements.add(place);
  const unwatch = watchLayout();
  const resizeObserver = new ResizeObserver(place);
  resizeObserver.observe(slot);
  place();
  return () => {
    resizeObserver.disconnect();
    placements.delete(place);
    unwatch();
  };
}
