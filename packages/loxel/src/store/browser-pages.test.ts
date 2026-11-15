import { beforeEach, describe, expect, test } from "bun:test";

import type { DockviewPanelApi } from "dockview-react";

import {
  attachBrowserPage,
  closeBrowserPage,
  closeLayoutBrowserPages,
  detachBrowserPage,
  setBrowserPageUrl,
  useBrowserPages,
  whenBrowserPageAttached,
} from "./browser-pages";
import { usePanelNotificationStore } from "./panel-notifications";
import { useSettingsStore } from "./settings-store";
import { useWorktreeStore } from "./worktrees";

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

function setLimit(backgroundPages: number): void {
  useSettingsStore.setState((s) => ({ browser: { ...s.browser, backgroundPages } }));
}

beforeEach(() => {
  for (const id of loaded()) closeBrowserPage(id);
  slots.clear();
  setLimit(2);
  useSettingsStore.setState((s) => ({ browser: { ...s.browser, notificationSites: {} } }));
  usePanelNotificationStore.setState({ panelIndex: new Set() });
  // Pages hidden here are in layouts that are not being shown.
  useWorktreeStore.setState({ activeWorktreePath: "/wt/elsewhere" });
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

  test("unloads the least recently shown background pages past the limit", () => {
    for (const id of ["p1", "p2", "p3"]) show(id);
    for (const id of ["p2", "p1", "p3"]) hide(id);
    expect(loaded().toSorted()).toEqual(["p1", "p3"]);
  });

  test("a switch doesn't unload the pages of the layout it is about to show", () => {
    setLimit(3);
    // B's pages went to the background first, so they are the least recently shown.
    for (const id of ["b1", "b2"]) show(id, "/wt/b");
    show("c1", "/wt/c");
    for (const id of ["b1", "b2", "c1"]) hide(id);
    show("a1", "/wt/a");
    // Switching to B: A's panel unmounts before B's mount.
    useWorktreeStore.setState({ activeWorktreePath: "/wt/b" });
    hide("a1");
    expect(loaded().toSorted()).toEqual(["a1", "b1", "b2", "c1"]);
    for (const id of ["b1", "b2"]) show(id, "/wt/b");
    expect(background().toSorted()).toEqual(["a1", "c1"]);
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

  test("unloads pages that can't notify before those that can", () => {
    for (const id of ["allowed", "pending", "plain"]) show(id);
    useSettingsStore.setState((s) => ({
      browser: { ...s.browser, notificationSites: { "https://allowed.test": "allow" } },
    }));
    usePanelNotificationStore.setState({ panelIndex: new Set(["pending"]) });
    for (const id of ["allowed", "pending", "plain"]) hide(id);
    expect(loaded().toSorted()).toEqual(["allowed", "pending"]);
  });

  test("a lower limit applies when the next page goes to the background, and 0 unloads each", () => {
    for (const id of ["p1", "p2"]) show(id);
    for (const id of ["p1", "p2"]) hide(id);
    show("p3");
    setLimit(0);
    expect(loaded()).toEqual(["p1", "p2", "p3"]);
    hide("p3");
    expect(loaded()).toEqual([]);
  });

  test("an unloaded page comes back on the last URL it was on", () => {
    show("p1", "/wt/a", "https://first.test/");
    setBrowserPageUrl("p1", "https://later.test/");
    setLimit(0);
    hide("p1");
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
