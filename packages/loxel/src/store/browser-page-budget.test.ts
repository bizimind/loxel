import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import type { DockviewPanelApi } from "dockview-react";

import type { BrowserPageUsage } from "@/electron/browser-page-protocol";
import { stubElectronAPI } from "@/test/electron-api-stub";

import {
  BUDGET_PROFILES,
  type PageCandidate,
  planBackgroundPages,
  reviewBackgroundPages,
} from "./browser-page-budget";
import {
  attachBrowserPage,
  closeBrowserPage,
  detachBrowserPage,
  setBrowserPageWebContents,
  useBrowserPages,
} from "./browser-pages";
import { useSettingsStore } from "./settings-store";
import { useWorktreeStore } from "./worktrees";

const MINUTE = 60_000;
const GB = 1024 * 1024;
/** A 10 GB machine, so Balanced allows background pages 2 GB together. */
const TOTAL_KB = 10 * GB;

function page(id: string, fields: Partial<PageCandidate> = {}): PageCandidate {
  return {
    id,
    hiddenForMs: MINUTE,
    memoryKB: 100 * 1024,
    cpuPercent: 0,
    frozen: false,
    canNotify: false,
    local: false,
    inUse: false,
    ...fields,
  };
}

const plan = (pages: PageCandidate[], mode: keyof typeof BUDGET_PROFILES = "balanced") =>
  planBackgroundPages(pages, BUDGET_PROFILES[mode], TOTAL_KB);

describe("background page budget", () => {
  test("within the budget, nothing is unloaded", () => {
    expect(plan([page("a", { memoryKB: GB }), page("b", { memoryKB: GB })]).unload).toEqual([]);
  });

  test("over it, unloads the most points first (memory times time hidden) until within", () => {
    const pages = [
      page("big-recent", { memoryKB: 1.5 * GB, hiddenForMs: MINUTE }),
      page("small-old", { memoryKB: 0.2 * GB, hiddenForMs: 60 * MINUTE }),
      page("big-old", { memoryKB: 1 * GB, hiddenForMs: 30 * MINUTE }),
    ];
    // 2.7 GB in a 2 GB budget: big-old has the most points, and dropping it is enough.
    expect(plan(pages).unload).toEqual(["big-old"]);
  });

  test("pages that can notify are unloaded last", () => {
    const pages = [
      page("notifies", { memoryKB: 1.8 * GB, hiddenForMs: 60 * MINUTE, canNotify: true }),
      page("quiet", { memoryKB: 0.5 * GB, hiddenForMs: MINUTE }),
    ];
    expect(plan(pages).unload).toEqual(["quiet"]);
    // Still over the budget once every page that can't notify is gone.
    const heavier = [{ ...pages[0]!, memoryKB: 2.5 * GB }, pages[1]!];
    expect(plan(heavier).unload).toEqual(["quiet", "notifies"]);
  });

  test("the budget follows the mode", () => {
    const pages = [page("a", { memoryKB: 1.5 * GB })];
    expect(plan(pages, "save-memory").unload).toEqual(["a"]);
    expect(plan(pages, "balanced").unload).toEqual([]);
  });

  test("freezes pages still using CPU after being hidden long enough", () => {
    const busy = { cpuPercent: 5, hiddenForMs: 10 * MINUTE };
    const pages = [
      page("busy", busy),
      page("idle", { ...busy, cpuPercent: 0.2 }),
      page("recent", { ...busy, hiddenForMs: MINUTE }),
      page("notifies", { ...busy, canNotify: true }),
      page("dev-server", { ...busy, local: true }),
      page("playing", { ...busy, inUse: true }),
      page("already", { ...busy, frozen: true }),
    ];
    expect(plan(pages).freeze).toEqual(["busy"]);
    expect(plan(pages, "save-memory").freeze).toEqual(["busy", "recent"]);
    expect(plan(pages, "keep-running").freeze).toEqual([]);
  });

  test("pages playing sound or with DevTools open are unloaded last", () => {
    const pages = [
      page("playing", { memoryKB: 2 * GB, hiddenForMs: 60 * MINUTE, inUse: true }),
      page("quiet", { memoryKB: 0.5 * GB }),
    ];
    expect(plan(pages).unload).toEqual(["quiet"]);
  });

  test("a page being unloaded isn't frozen too", () => {
    const pages = [page("busy", { memoryKB: 3 * GB, cpuPercent: 5, hiddenForMs: 10 * MINUTE })];
    expect(plan(pages)).toEqual({ freeze: [], unload: ["busy"] });
  });
});

describe("reviewing background pages", () => {
  const GUEST = 7;
  let used: BrowserPageUsage;
  const setBrowserPageFrozen = jest.fn(async () => true);
  const slot = { element: document.createElement("div"), api: {} as DockviewPanelApi };

  beforeEach(() => {
    for (const id of Object.keys(useBrowserPages.getState().pages)) closeBrowserPage(id);
    setBrowserPageFrozen.mockClear();
    used = { webContentsId: GUEST, memoryKB: 0.1 * GB, cpuPercent: 5, inUse: false };
    window.electronAPI = stubElectronAPI({
      getBrowserPageUsage: async () => ({ totalMemoryKB: TOTAL_KB, pages: [used] }),
      setBrowserPageFrozen,
    });
    useWorktreeStore.setState({ activeWorktreePath: "/wt/shown" });
    useSettingsStore.setState((s) => ({ browser: { ...s.browser, backgroundTabs: "balanced" } }));
    attachBrowserPage("busy", { layoutKey: "/wt/a", url: "https://busy.test/", slot });
    setBrowserPageWebContents("busy", GUEST);
  });

  afterEach(() => {
    window.electronAPI = undefined;
  });

  /** Hide the page `ms` ago. */
  function hideFor(ms: number): void {
    detachBrowserPage("busy", slot.element);
    const page = useBrowserPages.getState().pages.busy!;
    useBrowserPages.setState({ pages: { busy: { ...page, hiddenSince: Date.now() - ms } } });
  }

  test("freezes a busy page hidden long enough, by its current guest", async () => {
    hideFor(10 * MINUTE);
    await reviewBackgroundPages();
    expect(setBrowserPageFrozen).toHaveBeenCalledWith(GUEST, true);
    expect(useBrowserPages.getState().pages.busy?.frozen).toBe(true);
  });

  test("spares a page playing sound", async () => {
    used = { ...used, inUse: true };
    hideFor(10 * MINUTE);
    await reviewBackgroundPages();
    expect(setBrowserPageFrozen).not.toHaveBeenCalled();
  });

  test("leaves a page shown during the measurement alone", async () => {
    hideFor(10 * MINUTE);
    const review = reviewBackgroundPages();
    attachBrowserPage("busy", { layoutKey: "/wt/a", url: "https://busy.test/", slot });
    await review;
    expect(setBrowserPageFrozen).not.toHaveBeenCalled();
  });

  test("doesn't mark a page frozen that main didn't freeze", async () => {
    setBrowserPageFrozen.mockImplementation(async () => false);
    hideFor(10 * MINUTE);
    await reviewBackgroundPages();
    expect(useBrowserPages.getState().pages.busy?.frozen).toBe(false);
  });

  test("unloads a page over the budget", async () => {
    used = { ...used, memoryKB: 3 * GB };
    hideFor(MINUTE);
    await reviewBackgroundPages();
    expect(useBrowserPages.getState().pages.busy).toBeUndefined();
  });
});
