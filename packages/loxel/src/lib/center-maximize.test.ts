import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DockviewComponent, type DockviewApi, type IDockviewPanel } from "dockview-react";

import { layoutSnapshot } from "@/components/dockview/layout-snapshot";
import { findAdjacentCenterGroup } from "@/store/layout-actions";
import { setCenterApi } from "@/store/tools-bar";

import {
  activeGroupMaximizeLabel,
  canToggleActiveGroupMaximized,
  restoreLayoutWhenAnotherGroupActivates,
  togglePanelMaximized,
  toggleActiveGroupMaximized,
} from "./center-maximize";

let dockview: DockviewComponent;
let api: DockviewApi;

function addPanel(id: string, position?: Parameters<DockviewApi["addPanel"]>[0]["position"]) {
  return api.addPanel({ id, component: "default", position });
}

beforeEach(() => {
  dockview = new DockviewComponent(document.createElement("div"), {
    createComponent: () => ({ element: document.createElement("div"), init() {} }),
  });
  dockview.layout(1000, 500);
  api = dockview.api;
  setCenterApi(api);
  restoreLayoutWhenAnotherGroupActivates(api);
});

afterEach(() => {
  setCenterApi(null);
  dockview.dispose();
});

describe("toggling a center group's maximized state", () => {
  test("is unavailable with no panel, or one group with nothing to hide", () => {
    expect(canToggleActiveGroupMaximized()).toBe(false);
    addPanel("a");
    expect(canToggleActiveGroupMaximized()).toBe(false);
  });

  test("is unavailable for a floating group", () => {
    addPanel("a");
    const floating: IDockviewPanel = addPanel("b", { direction: "right" });
    api.addFloatingGroup(floating);
    expect(floating.group.api.location.type).toBe("floating");
    expect(canToggleActiveGroupMaximized()).toBe(false);
  });

  test("maximizes the active group and restores it, naming what it would do next", () => {
    addPanel("a");
    const b = addPanel("b", { direction: "right" });
    expect(activeGroupMaximizeLabel()).toBe("Maximize Group");

    toggleActiveGroupMaximized();
    expect(b.group.api.isMaximized()).toBe(true);
    expect(activeGroupMaximizeLabel()).toBe("Restore Group Size");
    expect(canToggleActiveGroupMaximized()).toBe(true);

    toggleActiveGroupMaximized();
    expect(api.hasMaximizedGroup()).toBe(false);
    expect(activeGroupMaximizeLabel()).toBe("Maximize Group");
  });

  test("brings a background tab to the front when maximizing its group", () => {
    const a = addPanel("a");
    addPanel("a2", { referencePanel: a });
    addPanel("b", { direction: "right" });

    togglePanelMaximized(a);

    expect(a.group.api.isMaximized()).toBe(true);
    expect(a.group.activePanel).toBe(a);
    expect(api.activePanel).toBe(a);
  });

  test("activating another group restores the layout", () => {
    const a = addPanel("a");
    const b = addPanel("b", { direction: "right" });
    toggleActiveGroupMaximized();
    a.api.setActive();
    expect(api.hasMaximizedGroup()).toBe(false);
    expect(b.group.api.isMaximized()).toBe(false);
  });
});

describe("while a group is maximized", () => {
  test("closing a hidden group's active tab restores the layout rather than activating it behind", () => {
    const a = addPanel("a");
    const b = addPanel("b", { direction: "right" });
    const b2 = addPanel("b2", { referencePanel: b });
    togglePanelMaximized(a);

    b2.api.close();

    expect(api.hasMaximizedGroup()).toBe(false);
    expect(activeGroupMaximizeLabel()).toBe("Maximize Group");
  });

  test("no other group counts as adjacent", () => {
    const a = addPanel("a");
    const b = addPanel("b", { direction: "right" });
    expect(findAdjacentCenterGroup(api, a.group, "right")).toBe(b.group);
    togglePanelMaximized(a);
    expect(findAdjacentCenterGroup(api, a.group, "right")).toBeNull();
  });

  test("saving leaves the state out, and keeps the group maximized", () => {
    addPanel("a");
    const b = addPanel("b", { direction: "right" });
    toggleActiveGroupMaximized();

    expect(api.toJSON().grid).toHaveProperty("maximizedNode");
    expect(layoutSnapshot(api).grid).not.toHaveProperty("maximizedNode");
    expect(b.group.api.isMaximized()).toBe(true);
  });
});
