import { describe, expect, mock, test } from "bun:test";

import type { DockviewApi, IDockviewPanel } from "dockview-react";

import { activatePanel } from "./layout-actions";

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
