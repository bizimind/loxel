import { describe, expect, mock, test } from "bun:test";

import { DockviewComponent, type DockviewApi, type IDockviewPanel } from "dockview-react";

import { activatePanel, reattachActiveContent } from "./layout-actions";

function setup({ isGroupActiveTab = true, maximized = "none" as "none" | "self" | "other" } = {}) {
  const panelSetActive = mock();
  const groupSetActive = mock();
  const exitMaximizedGroup = mock();
  const group = {
    activePanel: undefined as unknown,
    api: { setActive: groupSetActive, isMaximized: () => maximized === "self" },
  };
  const panel = { group, api: { setActive: panelSetActive } };
  group.activePanel = isGroupActiveTab ? panel : {};
  const api = { hasMaximizedGroup: () => maximized !== "none", exitMaximizedGroup };
  return {
    run: () => activatePanel(api as unknown as DockviewApi, panel as unknown as IDockviewPanel),
    panelSetActive,
    groupSetActive,
    exitMaximizedGroup,
  };
}

describe("activatePanel", () => {
  test("activates the group (no content re-render) when the panel is already its group's active tab", () => {
    const s = setup();
    s.run();
    expect(s.groupSetActive).toHaveBeenCalledTimes(1);
    expect(s.panelSetActive).not.toHaveBeenCalled();
  });

  test("activates the panel when it is a background tab", () => {
    const s = setup({ isGroupActiveTab: false });
    s.run();
    expect(s.panelSetActive).toHaveBeenCalledTimes(1);
    expect(s.groupSetActive).not.toHaveBeenCalled();
  });

  test("exits another group's maximized state before activating the group", () => {
    const s = setup({ maximized: "other" });
    s.run();
    expect(s.exitMaximizedGroup).toHaveBeenCalledTimes(1);
    expect(s.groupSetActive).toHaveBeenCalledTimes(1);
  });

  test("keeps the panel's own group maximized", () => {
    const s = setup({ maximized: "self" });
    s.run();
    expect(s.exitMaximizedGroup).not.toHaveBeenCalled();
    expect(s.groupSetActive).toHaveBeenCalledTimes(1);
  });
});

describe("reattachActiveContent", () => {
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

  test("restores content blanked by restoring a background always-rendered tab", () => {
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
        orientation: "HORIZONTAL",
      },
      panels: {
        editor: { id: "editor", contentComponent: "c" },
        browser: { id: "browser", contentComponent: "c", renderer: "always" },
      },
    } as Parameters<DockviewComponent["fromJSON"]>[0]);
    expect(isAttached(dockview, "editor")).toBe(false);

    for (const group of dockview.groups) reattachActiveContent(group);
    expect(isAttached(dockview, "editor")).toBe(true);
  });

  test("restores content blanked by upgrading a background tab's renderer", () => {
    const dockview = createDockview();
    dockview.addPanel({ id: "browser", component: "c" });
    dockview.addPanel({ id: "editor", component: "c" });
    const browser = dockview.getGroupPanel("browser");
    if (!browser) throw new Error("browser panel missing");

    browser.api.setRenderer("always");
    expect(isAttached(dockview, "editor")).toBe(false);

    reattachActiveContent(browser.group);
    expect(isAttached(dockview, "editor")).toBe(true);
    expect(browser.view.content.element.isConnected).toBe(true);
  });
});
