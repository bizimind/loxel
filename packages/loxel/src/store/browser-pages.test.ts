import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";

import type { DockviewPanelApi } from "dockview-react";

import { localRef } from "@/api/local-server";
import { stubElectronAPI } from "@/test/electron-api-stub";

import {
  attachBrowserPage,
  backgroundBrowserPages,
  closeBrowserPage,
  closeLayoutBrowserPages,
  detachBrowserPage,
  markBrowserPageFrozen,
  setBrowserPageUrl,
  setBrowserPageWebContents,
  unloadBrowserPages,
  useBrowserPages,
  whenBrowserPageAttached,
} from "./browser-pages";
import { usePanelNotificationStore } from "./panel-notifications";
import { useSettingsStore } from "./settings-store";
import { activeWorktreeFields, useWorktreeStore } from "./worktrees";

const api = {} as DockviewPanelApi;
const slots = new Map<string, HTMLElement>();

/** Show panel `id` of `layoutKey`, whose `url` param is `url`. */
function show(id: string, layoutKey = "/wt/a", url = `https://${id}.test/`): void {
  const element = document.createElement("div");
  slots.set(id, element);
  attachBrowserPage(id, { layoutKey, url, slot: { element, api } });
}

function hide(id: string): void {
  const element = slots.get(id);
  if (element) detachBrowserPage(id, element);
}

const loaded = () => Object.keys(useBrowserPages.getState().pages);
const background = () =>
  Object.values(useBrowserPages.getState().pages)
    .filter((page) => !page.slot)
    .map((page) => page.id);

const setBrowserPageFrozen = jest.fn(async () => true);
// Each page goes to the background a millisecond after the previous one.
let now = 0;
let clock: ReturnType<typeof spyOn<DateConstructor, "now">>;

beforeEach(() => {
  for (const id of loaded()) closeBrowserPage(id);
  slots.clear();
  now = 0;
  clock = spyOn(Date, "now").mockImplementation(() => ++now);
  setBrowserPageFrozen.mockClear();
  window.electronAPI = stubElectronAPI({ setBrowserPageFrozen });
  useSettingsStore.setState((s) => ({ browser: { ...s.browser, notificationSites: {} } }));
  usePanelNotificationStore.setState({ panelIndex: new Set() });
  // Pages hidden here are in layouts that are not being shown.
  useWorktreeStore.setState(activeWorktreeFields(localRef("/wt/elsewhere")));
});

afterEach(() => {
  clock.mockRestore();
  window.electronAPI = undefined;
});

describe("browser pages", () => {
  test("a page keeps running in the background when its panel is hidden, and is shown again", () => {
    show("p1");
    hide("p1");
    expect(background()).toEqual(["p1"]);
    show("p1");
    expect(background()).toEqual([]);
    expect(useBrowserPages.getState().pages.p1?.slot?.element).toBe(slots.get("p1"));
  });

  test("a stale slot's detach leaves the page shown in its new slot", () => {
    show("p1");
    const old = slots.get("p1")!;
    show("p1");
    detachBrowserPage("p1", old);
    expect(background()).toEqual([]);
  });

  test("past 100 background pages, unloads the one hidden longest", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `p${i}`);
    for (const id of ids) show(id);
    for (const id of ids) hide(id);
    expect(loaded()).toEqual(ids.slice(1));
  });

  test("a switch doesn't count the pages of the layout it is about to show", () => {
    for (const id of ["b1", "b2"]) show(id, "/wt/b");
    for (const id of ["b1", "b2"]) hide(id);
    show("a1", "/wt/a");
    // Switching to B: A's panel unmounts before B's mount.
    useWorktreeStore.setState(activeWorktreeFields(localRef("/wt/b")));
    hide("a1");
    expect(backgroundBrowserPages().map((page) => page.id)).toEqual(["a1"]);
  });

  test("a frozen page resumes when shown, then is shown to Chromium again", async () => {
    show("p1");
    setBrowserPageWebContents("p1", 7);
    hide("p1");
    markBrowserPageFrozen("p1", 7);
    expect(useBrowserPages.getState().pages.p1?.frozen).toBe(true);
    show("p1");
    expect(setBrowserPageFrozen).toHaveBeenCalledWith(7, false);
    expect(useBrowserPages.getState().pages.p1?.frozen).toBe(false);
    await Promise.resolve();
    expect(useBrowserPages.getState().pages.p1?.resumes).toBe(1);
  });

  test("a page shown while it was being frozen is resumed at once", () => {
    show("p1");
    setBrowserPageWebContents("p1", 7);
    markBrowserPageFrozen("p1", 7);
    expect(setBrowserPageFrozen).toHaveBeenCalledWith(7, false);
    expect(useBrowserPages.getState().pages.p1?.frozen).toBe(false);
  });

  test("a freeze of a replaced guest is ignored, and a new guest starts unfrozen", () => {
    show("p1");
    setBrowserPageWebContents("p1", 7);
    hide("p1");
    markBrowserPageFrozen("p1", 7);
    setBrowserPageWebContents("p1", 8);
    expect(useBrowserPages.getState().pages.p1).toMatchObject({ webContentsId: 8, frozen: false });
    markBrowserPageFrozen("p1", 7);
    expect(useBrowserPages.getState().pages.p1?.frozen).toBe(false);
  });

  test("calls back once a page is attached, at once if it already is", () => {
    const attached: string[] = [];
    show("p1");
    whenBrowserPageAttached("p1", () => attached.push("p1"));
    hide("p1");
    whenBrowserPageAttached("p1", () => attached.push("p1 again"));
    expect(attached).toEqual(["p1"]);
    show("p1");
    show("p1");
    expect(attached).toEqual(["p1", "p1 again"]);
  });

  test("calls back with no slot when the page's layout doesn't mount in time", () => {
    jest.useFakeTimers();
    try {
      const results: unknown[] = [];
      whenBrowserPageAttached("gone", (slot) => results.push(slot));
      jest.advanceTimersByTime(5000);
      expect(results).toEqual([null]);
      // Showing it later doesn't call back again.
      show("gone");
      expect(results).toEqual([null]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("an unloaded page comes back on the last URL it was on", () => {
    show("p1", "/wt/a", "https://first.test/");
    setBrowserPageUrl("p1", "https://later.test/");
    hide("p1");
    unloadBrowserPages(["p1"]);
    show("p1", "/wt/a", "https://first.test/");
    expect(useBrowserPages.getState().pages.p1?.initialUrl).toBe("https://later.test/");
  });

  test("closing a panel or removing its worktree unloads its pages for good", () => {
    show("a1", "/wt/a", "https://a1.test/");
    show("b1", "/wt/b", "https://b1.test/");
    setBrowserPageUrl("a1", "https://a1.test/later");
    hide("a1");
    closeLayoutBrowserPages("/wt/a");
    expect(loaded()).toEqual(["b1"]);
    // A panel with the same id later starts on its own URL, not the removed one's.
    show("a1", "/wt/a", "https://a1.test/");
    expect(useBrowserPages.getState().pages.a1?.initialUrl).toBe("https://a1.test/");

    closeBrowserPage("b1");
    expect(loaded()).toEqual(["a1"]);
  });
});
