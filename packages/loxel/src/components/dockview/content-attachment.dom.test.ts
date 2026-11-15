/**
 * Dockview keeps a group's shown content attached through the operations Loxel relies on. Browser
 * panels hold an Electron `<webview>`, which reloads its page whenever its element is re-attached,
 * so these pin the dockview behavior that lets Loxel call `panel.api.setActive()` and add, move or
 * restore `renderer: "always"` tabs without workarounds.
 */
import { describe, expect, test } from "bun:test";

import { DockviewApi, DockviewComponent, Orientation } from "dockview-react";

describe("dockview content attachment", () => {
  function createDockview() {
    const element = document.createElement("div");
    document.body.append(element);
    const dockview = new DockviewComponent(element, {
      createComponent: () => ({ element: document.createElement("div"), init: () => {} }),
    });
    dockview.layout(800, 600);
    return dockview;
  }

  function isAttached(dockview: DockviewComponent, id: string) {
    const panel = dockview.getGroupPanel(id);
    return panel !== undefined && panel.view.content.element.parentElement !== null;
  }

  test.each(["always", "onlyWhenVisible"] as const)(
    "activates an already visible %s panel without detaching its content",
    (renderer) => {
      const dockview = createDockview();
      const api = new DockviewApi(dockview);
      const browser = api.addPanel({ id: "browser", component: "c", renderer });
      api.addPanel({ id: "editor", component: "c", position: { direction: "right" } });
      const content = browser.view.content.element;
      const observer = new MutationObserver(() => {});
      observer.observe(dockview.element, { childList: true, subtree: true });

      browser.api.setActive();

      expect(api.activePanel).toBe(browser);
      expect(content.isConnected).toBe(true);
      expect(
        observer
          .takeRecords()
          .some((record) =>
            [...record.removedNodes].some((node) => node === content || node.contains(content)),
          ),
      ).toBe(false);
      observer.disconnect();
      dockview.dispose();
      dockview.element.remove();
    },
  );

  test("activating a visible tab hidden behind another maximized group un-maximizes it in place", () => {
    const dockview = createDockview();
    const api = new DockviewApi(dockview);
    const browser = api.addPanel({ id: "browser", component: "c", renderer: "always" });
    const editor = api.addPanel({ id: "editor", component: "c", position: { direction: "right" } });
    editor.api.maximize();
    const content = browser.view.content.element;
    const observer = new MutationObserver(() => {});
    observer.observe(dockview.element, { childList: true, subtree: true });

    browser.api.setActive();

    expect(api.hasMaximizedGroup()).toBe(false);
    expect(api.activePanel).toBe(browser);
    expect(
      observer
        .takeRecords()
        .some((record) =>
          [...record.removedNodes].some((node) => node === content || node.contains(content)),
        ),
    ).toBe(false);
    observer.disconnect();
    dockview.dispose();
    dockview.element.remove();
  });

  test("keeps active content attached when restoring a background always-rendered tab", () => {
    const dockview = createDockview();
    dockview.fromJSON({
      grid: {
        root: {
          type: "branch",
          data: [
            { type: "leaf", data: { id: "g", views: ["editor", "browser"], activeView: "editor" } },
          ],
        },
        width: 800,
        height: 600,
        orientation: Orientation.HORIZONTAL,
      },
      panels: {
        editor: { id: "editor", contentComponent: "c" },
        browser: { id: "browser", contentComponent: "c", renderer: "always" },
      },
    } as Parameters<DockviewComponent["fromJSON"]>[0]);
    expect(isAttached(dockview, "editor")).toBe(true);
    dockview.dispose();
    dockview.element.remove();
  });

  test("keeps active content attached when adding an always-rendered tab in the background", () => {
    const dockview = createDockview();
    const api = new DockviewApi(dockview);
    const editor = api.addPanel({ id: "editor", component: "c" });
    const browser = api.addPanel({
      id: "browser",
      component: "c",
      renderer: "always",
      inactive: true,
    });

    expect(api.activePanel).toBe(editor);
    expect(isAttached(dockview, "editor")).toBe(true);
    expect(browser.view.content.element.isConnected).toBe(true);
    dockview.dispose();
    dockview.element.remove();
  });

  test("keeps active content attached when merging a group with a background always-rendered tab", () => {
    const dockview = createDockview();
    dockview.addPanel({ id: "editor", component: "c" });
    dockview.addPanel({ id: "browser", component: "c", renderer: "always" });
    dockview.addPanel({ id: "other", component: "c", position: { direction: "right" } });
    const editor = dockview.getGroupPanel("editor");
    const other = dockview.getGroupPanel("other");
    if (!editor || !other) throw new Error("panels missing");
    editor.api.setActive();

    editor.group.api.moveTo({ group: other.group, position: "center" });
    expect(isAttached(dockview, "editor")).toBe(true);
    dockview.dispose();
    dockview.element.remove();
  });

  test("keeps active content attached when upgrading a background tab's renderer", () => {
    const dockview = createDockview();
    dockview.addPanel({ id: "browser", component: "c" });
    dockview.addPanel({ id: "editor", component: "c" });
    const browser = dockview.getGroupPanel("browser");
    if (!browser) throw new Error("browser panel missing");

    browser.api.setRenderer("always");
    expect(isAttached(dockview, "editor")).toBe(true);
    expect(browser.view.content.element.isConnected).toBe(true);
    dockview.dispose();
    dockview.element.remove();
  });
});
