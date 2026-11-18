import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DockviewApi,
  DockviewComponent,
  type IContentRenderer,
  Orientation,
  type SerializedDockview,
} from "dockview-react";

import { localRef } from "@/api/local-server";
import { movePanelToZone, setDockviewApi } from "@/store/tools-bar";
import { purgeWorktreeStores } from "@/store/worktree-store";
import { getCurrentWorktreeToolsBar } from "@/store/worktree-tools-bar";
import { activeWorktreeFields, useWorktreeStore } from "@/store/worktrees";

import { onOuterLayoutRestored, setupOuterDockview } from "./outer-dockview-setup";

function panel(id: string) {
  return { id, contentComponent: id, title: id };
}

function leaf(id: string, views: string[], size: number) {
  return { type: "leaf" as const, size, data: { id, views, activeView: views[0] } };
}

// A saved outer layout with the center host and one left zone, the right and bottom zones empty.
const saved = {
  grid: {
    root: {
      type: "branch" as const,
      data: [leaf("left", ["changes", "projectFiles"], 250), leaf("center", ["centerHost"], 750)],
    },
    width: 1000,
    height: 800,
    orientation: Orientation.HORIZONTAL,
  },
  panels: {
    centerHost: panel("centerHost"),
    changes: panel("changes"),
    projectFiles: panel("projectFiles"),
  },
} satisfies SerializedDockview;

const WT = "/repo/wt";

let dockview: DockviewComponent | undefined;

beforeEach(() => {
  purgeWorktreeStores(localRef(WT));
  useWorktreeStore.setState(activeWorktreeFields(localRef(WT)));
});

afterEach(() => {
  setDockviewApi(null);
  dockview?.dispose();
  dockview = undefined;
});

describe("the outer dockview", () => {
  test("shows no tab row on a group created after a layout restore", () => {
    dockview = new DockviewComponent(document.createElement("div"), {
      createComponent: (): IContentRenderer => ({
        element: document.createElement("div"),
        init: () => {},
      }),
    });
    const api = new DockviewApi(dockview);
    dockview.fromJSON(saved);
    setupOuterDockview(api);
    // happy-dom lays nothing out, so zones can't be read from group positions: set them directly.
    getCurrentWorktreeToolsBar().setState({
      leftEntries: [{ panelId: "changes" }, { panelId: "projectFiles" }],
      bottomEntries: [],
      rightEntries: [],
    });
    onOuterLayoutRestored(api);
    expect(api.groups.every((group) => group.header.hidden)).toBe(true);

    // The right zone has no group, so the move creates one.
    const groupCount = api.groups.length;
    movePanelToZone("projectFiles", "right");

    expect(api.groups).toHaveLength(groupCount + 1);
    expect(api.getPanel("projectFiles")?.group.header.hidden).toBe(true);
  });
});
