/**
 * The browser pages of the window, kept loaded across worktree switches.
 *
 * A `<webview>` reloads when it is re-attached to the DOM, and a worktree switch rebuilds the
 * center layout. So browser pages don't live in their dockview panels: the window-level
 * `BrowserPagePool` renders every page, and a browser panel only lends it a slot to be shown over
 * (`attachBrowserPage`). A page whose panel's layout is not shown stays loaded in the background
 * until its panel closes, its worktree is removed, or it is unloaded to keep at most
 * `browser.backgroundPages` background pages (`evictBackgroundPages`); its panel then loads it
 * again the next time it is shown.
 */
import type { DockviewPanelApi } from "dockview-react";
import { create } from "zustand";

import { activeLayoutKey } from "./active-worktree";
import { usePanelNotificationStore } from "./panel-notifications";
import { useSettingsStore } from "./settings-store";

/** Where a page is shown: its browser panel, while that panel's layout is mounted. */
export interface PageSlot {
  /** The element in the panel's content that the page is positioned over. */
  element: HTMLElement;
  /** The panel, for its title and params, and to activate it. */
  api: DockviewPanelApi;
}

export interface BrowserPage {
  /** The browser panel's dockview id. */
  id: string;
  /** The layout the panel is in: a worktree path, or Home's key. */
  layoutKey: string;
  /** The URL the page was loaded on. */
  initialUrl: string;
  /** Where the page is shown. Null while it runs in the background. */
  slot: PageSlot | null;
  /** When the page was last shown or hidden, as a counter; the least recent is unloaded first. */
  lastShown: number;
}

interface BrowserPagesState {
  /** The loaded pages by panel id, in the order they were loaded (the pool's DOM order). */
  pages: Readonly<Record<string, BrowserPage>>;
}

export const useBrowserPages = create<BrowserPagesState>()(() => ({ pages: {} }));

let clock = 0;

/**
 * The URL each panel's page is on, unloaded pages included, so a page unloaded after it navigated
 * comes back on its last URL rather than the one its layout saved when it was hidden.
 */
const pageUrls = new Map<string, { layoutKey: string; url: string }>();

function setPages(update: (pages: Record<string, BrowserPage>) => void): void {
  const pages = { ...useBrowserPages.getState().pages };
  update(pages);
  useBrowserPages.setState({ pages });
}

/**
 * Show panel `id`'s page in `slot`, loading it on `url` (the panel's `url` param) if it isn't
 * loaded.
 */
export function attachBrowserPage(
  id: string,
  { layoutKey, url, slot }: { layoutKey: string; url: string; slot: PageSlot },
): void {
  setPages((pages) => {
    const page = pages[id] ?? {
      id,
      layoutKey,
      initialUrl: pageUrls.get(id)?.url ?? url,
      slot: null,
      lastShown: 0,
    };
    pages[id] = { ...page, slot, lastShown: ++clock };
  });
}

/** Panel `id` no longer shows its page in `element`: keep the page running in the background. */
export function detachBrowserPage(id: string, element: HTMLElement): void {
  const page = useBrowserPages.getState().pages[id];
  if (page?.slot?.element !== element) return;
  setPages((pages) => {
    pages[id] = { ...page, slot: null, lastShown: ++clock };
  });
  evictBackgroundPages();
}

/** Record the URL panel `id`'s page is on. */
export function setBrowserPageUrl(id: string, url: string): void {
  const page = useBrowserPages.getState().pages[id];
  if (page) pageUrls.set(id, { layoutKey: page.layoutKey, url });
}

/** Unload panel `id`'s page for good: its panel closed. */
export function closeBrowserPage(id: string): void {
  pageUrls.delete(id);
  if (!useBrowserPages.getState().pages[id]) return;
  setPages((pages) => {
    delete pages[id];
  });
}

/** Unload the pages of the panels in `layoutKey`'s layout for good: its worktree was removed. */
export function closeLayoutBrowserPages(layoutKey: string): void {
  for (const [id, { layoutKey: key }] of pageUrls) {
    if (key === layoutKey) pageUrls.delete(id);
  }
  const { pages } = useBrowserPages.getState();
  if (!Object.values(pages).some((page) => page.layoutKey === layoutKey)) return;
  setPages((next) => {
    for (const page of Object.values(next)) {
      if (page.layoutKey === layoutKey) delete next[page.id];
    }
  });
}

function originOf(url: string): string | null {
  return URL.canParse(url) ? new URL(url).origin : null;
}

/**
 * Whether a background page is worth keeping ahead of others: its site may notify, or it has a
 * notification in the notification center.
 */
function canNotify(page: BrowserPage): boolean {
  if (usePanelNotificationStore.getState().panelIndex.has(page.id)) return true;
  const origin = originOf(pageUrls.get(page.id)?.url ?? page.initialUrl);
  return (
    origin !== null && useSettingsStore.getState().browser.notificationSites[origin] === "allow"
  );
}

/**
 * Unload background pages past `browser.backgroundPages`: those that can't notify first, then the
 * least recently shown. Runs when a page goes to the background, not when the setting changes, so
 * a count typed in Settings and then cancelled unloads nothing. Pages of the layout being shown
 * don't count: during a switch the old layout's panels unmount before the new one's mount, and
 * those are about to be shown.
 */
function evictBackgroundPages(): void {
  const limit = useSettingsStore.getState().browser.backgroundPages;
  const shownLayout = activeLayoutKey();
  const background = Object.values(useBrowserPages.getState().pages).filter(
    (page) => !page.slot && page.layoutKey !== shownLayout,
  );
  const excess = background.length - limit;
  if (excess <= 0) return;
  const evicted = background
    .map((page) => ({ page, keep: canNotify(page) }))
    .toSorted((a, b) => Number(a.keep) - Number(b.keep) || a.page.lastShown - b.page.lastShown)
    .slice(0, excess);
  setPages((pages) => {
    for (const { page } of evicted) delete pages[page.id];
  });
}

/** How long `whenBrowserPageAttached` waits for a layout to mount before giving up. */
const ATTACH_TIMEOUT_MS = 5000;

/**
 * Call `attached` once panel `id`'s page has a slot, i.e. its panel's layout is mounted: now, or
 * once a worktree switch or going Home has mounted it (which can fetch the layout first). Never
 * called if that takes too long, e.g. the panel is gone.
 */
export function whenBrowserPageAttached(id: string, attached: (slot: PageSlot) => void): void {
  const slotOf = (state: BrowserPagesState) => state.pages[id]?.slot ?? null;
  const current = slotOf(useBrowserPages.getState());
  if (current) return attached(current);
  const unsubscribe = useBrowserPages.subscribe((state) => {
    const slot = slotOf(state);
    if (!slot) return;
    stop();
    attached(slot);
  });
  const timer = setTimeout(unsubscribe, ATTACH_TIMEOUT_MS);
  function stop(): void {
    clearTimeout(timer);
    unsubscribe();
  }
}
