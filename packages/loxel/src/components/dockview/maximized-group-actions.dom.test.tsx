import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DockviewComponent, type IDockviewHeaderActionsProps } from "dockview-react";

import { MaximizedGroupActions } from "./maximized-group-actions";

let dockview: DockviewComponent;

beforeEach(() => {
  dockview = new DockviewComponent(document.createElement("div"), {
    createComponent: () => ({ element: document.createElement("div"), init() {} }),
  });
  dockview.layout(1000, 500);
});

afterEach(() => {
  cleanup();
  dockview.dispose();
});

describe("MaximizedGroupActions", () => {
  test("offers Restore only while its group is maximized", () => {
    const panel = dockview.api.addPanel({ id: "a", component: "default" });
    dockview.api.addPanel({ id: "b", component: "default", position: { direction: "right" } });
    const props = {
      api: panel.group.api,
      containerApi: dockview.api,
    } as unknown as IDockviewHeaderActionsProps;
    render(<MaximizedGroupActions {...props} />);
    expect(screen.queryByRole("button")).toBeNull();

    act(() => panel.group.api.maximize());
    fireEvent.click(screen.getByRole("button", { name: "Restore Group Size" }));

    expect(panel.group.api.isMaximized()).toBe(false);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
