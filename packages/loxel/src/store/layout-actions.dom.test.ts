import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import {
  DockviewApi,
  DockviewComponent,
  type IContentRenderer,
  Orientation,
  type SerializedDockview,
} from "dockview-react";

import { localRef } from "@/api/local-server";

import { collapseZone, expandZone } from "./layout-actions";
import { ZONE_MIN_SIZES } from "./panel-config";
import { purgeWorktreeStores } from "./worktree-store";
import { getCurrentWorktreeToolsBar } from "./worktree-tools-bar";
import { activeWorktreeFields, useWorktreeStore } from "./worktrees";

function leaf(id: string, views: string[], size: number) {
  return { type: "leaf" as const, size, data: { id, views, activeView: views[0] } };
}

function panel(id: string) {
  return { id, contentComponent: id, title: id };
}

/** An outer layout with a left zone and a bottom zone around the center host. */
function savedLayout(left: number, bottom: number): SerializedDockview {
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "branch",
            size: 800 - bottom,
            data: [
              leaf("left", ["projectFiles"], left),
              leaf("center", ["centerHost"], 1000 - left),
            ],
          },
          leaf("bottom", ["git"], bottom),
        ],
      },
      width: 1000,
      height: 800,
      orientation: Orientation.VERTICAL,
    },
    panels: {
      centerHost: panel("centerHost"),
      projectFiles: panel("projectFiles"),
      git: panel("git"),
    },
  };
}

const WT = "/repo/wt";

let dockview: DockviewComponent | undefined;

function createLayout({ left = 250, bottom = 200 } = {}): DockviewApi {
  dockview = new DockviewComponent(document.createElement("div"), {
    createComponent: (): IContentRenderer => ({
      element: document.createElement("div"),
      init: () => {},
    }),
  });
  const api = new DockviewApi(dockview);
  dockview.fromJSON(savedLayout(left, bottom));
  api.layout(1000, 800);
  // happy-dom lays nothing out, so place the groups where the zone lookup reads them.
  const rects: Record<string, DOMRect> = {
    centerHost: new DOMRect(300, 0, 700, 600),
    projectFiles: new DOMRect(0, 0, 300, 600),
    git: new DOMRect(0, 600, 1000, 200),
  };
  for (const group of api.groups) {
    const rect = rects[group.panels[0]?.id ?? ""];
    if (rect) spyOn(group.element, "getBoundingClientRect").mockReturnValue(rect);
  }
  getCurrentWorktreeToolsBar().setState({
    leftEntries: [{ panelId: "projectFiles" }],
    bottomEntries: [{ panelId: "git" }],
    rightEntries: [],
  });
  return api;
}

const leftWidth = (api: DockviewApi) => api.getPanel("projectFiles")?.group.api.width;
const bottomHeight = (api: DockviewApi) => api.getPanel("git")?.group.api.height;
const savedSizes = () => getCurrentWorktreeToolsBar().getState().sidebarSizes;

beforeEach(() => {
  purgeWorktreeStores(localRef(WT));
  useWorktreeStore.setState(activeWorktreeFields(localRef(WT)));
  // Run the deferred resize at once instead of on the next frame.
  spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  mock.restore();
  dockview?.dispose();
  dockview = undefined;
});

describe("expandZone", () => {
  test("reopens a collapsed zone at its saved size, not at the minimum", () => {
    const api = createLayout({ left: 250, bottom: 200 });
    collapseZone(api, "left");
    collapseZone(api, "bottom");
    expect(leftWidth(api)).toBe(0);
    expect(bottomHeight(api)).toBe(0);

    expandZone(api, "left");
    expandZone(api, "bottom");

    expect(leftWidth(api)).toBe(250);
    expect(bottomHeight(api)).toBe(200);
    expect(savedSizes()).toMatchObject({ left: 250, bottom: 200 });
  });

  test("opens a zone saved below the minimum at the minimum", () => {
    const api = createLayout();
    collapseZone(api, "left", { skipSave: true });
    collapseZone(api, "bottom", { skipSave: true });

    expandZone(api, "left", { forceSize: 90 });
    expandZone(api, "bottom", { forceSize: 40 });

    expect(leftWidth(api)).toBe(ZONE_MIN_SIZES.left);
    expect(bottomHeight(api)).toBe(ZONE_MIN_SIZES.bottom);
  });

  test("grows an open zone narrower than the minimum and saves the grown size", () => {
    const api = createLayout({ left: 150, bottom: 100 });

    expandZone(api, "left");
    expandZone(api, "bottom");

    expect(leftWidth(api)).toBe(ZONE_MIN_SIZES.left);
    expect(bottomHeight(api)).toBe(ZONE_MIN_SIZES.bottom);
    expect(savedSizes()).toMatchObject({
      left: ZONE_MIN_SIZES.left,
      bottom: ZONE_MIN_SIZES.bottom,
    });
  });

  test("keeps the zone from being dragged below the minimum", () => {
    const api = createLayout();
    expandZone(api, "left");
    expandZone(api, "bottom");

    api.getPanel("projectFiles")?.group.api.setSize({ width: 90 });
    api.getPanel("git")?.group.api.setSize({ height: 40 });

    expect(leftWidth(api)).toBe(ZONE_MIN_SIZES.left);
    expect(bottomHeight(api)).toBe(ZONE_MIN_SIZES.bottom);
  });
});
