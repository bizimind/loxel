/**
 * The browser pages of the window, kept loaded across worktree switches.
 *
 * A `<webview>` reloads when it is re-attached to the DOM, and a worktree switch rebuilds the
 * center layout. So browser pages don't live in their dockview panels: the window-level
 * `BrowserPagePool` renders every page, and a browser panel only lends it a slot to be shown over
 * (`attachBrowserPage`). A page whose panel's layout is not shown runs in the background until its
 * panel closes or its worktree is removed. On the way it may be frozen and resumed, or unloaded and
 * loaded again the next time its panel is shown, to keep background pages within a budget
 * (`browser-page-budget.ts`).
 */
import type { DockviewPanelApi } from "dockview-react";
import { create } from "zustand";

import { activeLayoutKey, type LayoutKey, layoutServer } from "./active-worktree";
import { hasPanelNotification, usePanelNotificationStore } from "./panel-notifications";
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
  /** The layout the panel is in: a worktree's, or Home's. */
  layoutKey: LayoutKey;
  /** The URL the page was loaded on. */
  initialUrl: string;
  /** Where the page is shown. Null while it runs in the background. */
  slot: PageSlot | null;
  /** When the page went to the background (`Date.now()`), or null while it is shown. */
  hiddenSince: number | null;
  /** Its webview's guest webContents id, once the page has loaded. */
  webContentsId: number | null;
  /** Whether its tasks and timers are stopped (see `browser-page-budget.ts`). */
  frozen: boolean;
  /**
   * How many times it was resumed from a freeze. Chromium leaves a resumed page hidden, so the pool
   * hides and shows its host again on each.
   */
  resumes: number;
}

/**
 * Background pages kept at most, whatever the budget measures: a backstop for when it can't
 * measure (outside Electron, or a failed read).
 */
const MAX_BACKGROUND_PAGES = 100;

interface BrowserPagesState {
  /** The loaded pages by panel id, in the order they were loaded (the pool's DOM order). */
  pages: Readonly<Record<string, BrowserPage>>;
}

export const useBrowserPages = create<BrowserPagesState>()(() => ({ pages: {} }));

/**
 * The URL each panel's page is on, unloaded pages included, so a page unloaded after it navigated
 * comes back on its last URL rather than the one its layout saved when it was hidden.
 */
const pageUrls = new Map<string, { layoutKey: LayoutKey; url: string }>();

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
  { layoutKey, url, slot }: { layoutKey: LayoutKey; url: string; slot: PageSlot },
): void {
  const previous = useBrowserPages.getState().pages[id];
  setPages((pages) => {
    const page = pages[id] ?? {
      id,
      layoutKey,
      initialUrl: pageUrls.get(id)?.url ?? url,
      slot: null,
      hiddenSince: null,
      webContentsId: null,
      frozen: false,
      resumes: 0,
    };
    pages[id] = { ...page, slot, hiddenSince: null, frozen: false };
  });
  if (previous?.frozen && previous.webContentsId !== null) resume(id, previous.webContentsId);
}

/** Resume a frozen page being shown, then have the pool show it to Chromium again. */
function resume(id: string, webContentsId: number): void {
  void window.electronAPI?.setBrowserPageFrozen(webContentsId, false).then(() => {
    const page = useBrowserPages.getState().pages[id];
    if (!page || page.webContentsId !== webContentsId) return;
    setPages((pages) => {
      pages[id] = { ...page, resumes: page.resumes + 1 };
    });
  });
}

/**
 * The panels whose page is loading a new document, for their tabs' spinner. Apart from the pages
 * and from the panels' params, which are saved with the layout: it only says what a page is doing.
 */
const useLoadingPages = create<{ loading: Readonly<Record<string, true>> }>()(() => ({
  loading: {},
}));

/** Record whether panel `id`'s page is loading a new document. */
export function setBrowserPageLoading(id: string, loading: boolean): void {
  const current = useLoadingPages.getState().loading;
  if ((current[id] === true) === loading) return;
  const next = { ...current };
  if (loading) next[id] = true;
  else delete next[id];
  useLoadingPages.setState({ loading: next });
}

/** Whether panel `id`'s page is loading a new document, shown or in the background. */
export function useIsBrowserPageLoading(id: string): boolean {
  return useLoadingPages((state) => state.loading[id] === true);
}

/** Panel `id` no longer shows its page in `element`: keep the page running in the background. */
export function detachBrowserPage(id: string, element: HTMLElement): void {
  const page = useBrowserPages.getState().pages[id];
  if (page?.slot?.element !== element) return;
  setPages((pages) => {
    pages[id] = { ...page, slot: null, hiddenSince: Date.now() };
  });
  capBackgroundPages();
}

/** Record panel `id`'s webview guest, which a new guest (a crashed page reloaded) replaces. */
export function setBrowserPageWebContents(id: string, webContentsId: number): void {
  const page = useBrowserPages.getState().pages[id];
  if (!page || page.webContentsId === webContentsId) return;
  setPages((pages) => {
    pages[id] = { ...page, webContentsId, frozen: false };
  });
}

/**
 * Mark panel `id`'s page frozen, once main froze its guest `webContentsId`; one shown while it was
 * being frozen is resumed at once.
 */
export function markBrowserPageFrozen(id: string, webContentsId: number): void {
  const page = useBrowserPages.getState().pages[id];
  if (!page || page.frozen || page.webContentsId !== webContentsId) return;
  if (page.slot) {
    resume(id, webContentsId);
    return;
  }
  setPages((pages) => {
    pages[id] = { ...page, frozen: true };
  });
}

/** Unload background pages; their panels load them again when shown. */
export function unloadBrowserPages(ids: readonly string[]): void {
  if (ids.length === 0) return;
  setPages((pages) => {
    for (const id of ids) delete pages[id];
  });
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
export function closeLayoutBrowserPages(layoutKey: LayoutKey): void {
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

/** The URL panel `id`'s page is on. */
export function browserPageUrl(page: BrowserPage): string {
  return pageUrls.get(page.id)?.url ?? page.initialUrl;
}

function originOf(url: string): string | null {
  return URL.canParse(url) ? new URL(url).origin : null;
}

/**
 * Whether a background page is worth keeping ahead of others: its site may notify, or it has a
 * notification in the notification center.
 */
export function canNotify(page: BrowserPage): boolean {
  const server = layoutServer(page.layoutKey);
  if (hasPanelNotification(usePanelNotificationStore.getState(), server, page.id)) return true;
  const origin = originOf(browserPageUrl(page));
  return (
    origin !== null && useSettingsStore.getState().browser.notificationSites[origin] === "allow"
  );
}

/**
 * The pages in the background, as candidates for freezing or unloading. Pages of the layout being
 * shown don't count: during a switch the old layout's panels unmount before the new one's mount,
 * and those are about to be shown.
 */
export function backgroundBrowserPages(): BrowserPage[] {
  const shownLayout = activeLayoutKey();
  return Object.values(useBrowserPages.getState().pages).filter(
    (page) => !page.slot && page.layoutKey !== shownLayout,
  );
}

/**
 * Unload background pages past `MAX_BACKGROUND_PAGES`: those that can't notify first, then those
 * hidden longest.
 */
function capBackgroundPages(): void {
  const background = backgroundBrowserPages();
  const excess = background.length - MAX_BACKGROUND_PAGES;
  if (excess <= 0) return;
  const unloaded = background
    .map((page) => ({ page, keep: canNotify(page) }))
    .toSorted(
      (a, b) =>
        Number(a.keep) - Number(b.keep) || (a.page.hiddenSince ?? 0) - (b.page.hiddenSince ?? 0),
    )
    .slice(0, excess);
  unloadBrowserPages(unloaded.map(({ page }) => page.id));
}

/** Where panel `id`'s page is shown, or null while it is in the background or not loaded. */
export function getBrowserPageSlot(id: string): PageSlot | null {
  return useBrowserPages.getState().pages[id]?.slot ?? null;
}

/** How long `whenBrowserPageAttached` waits for a layout to mount. */
const ATTACH_TIMEOUT_MS = 5000;

/**
 * Call `attached` once panel `id`'s page has a slot, i.e. its panel's layout is mounted: now, or
 * once a worktree switch or going Home has mounted it (which can fetch the layout first). Called
 * with null if that takes too long, e.g. the panel is gone.
 */
export function whenBrowserPageAttached(
  id: string,
  attached: (slot: PageSlot | null) => void,
): void {
  const current = getBrowserPageSlot(id);
  if (current) return attached(current);
  const unsubscribe = useBrowserPages.subscribe((state) => {
    const slot = state.pages[id]?.slot;
    if (!slot) return;
    clearTimeout(timer);
    unsubscribe();
    attached(slot);
  });
  const timer = setTimeout(() => {
    unsubscribe();
    attached(null);
  }, ATTACH_TIMEOUT_MS);
}
