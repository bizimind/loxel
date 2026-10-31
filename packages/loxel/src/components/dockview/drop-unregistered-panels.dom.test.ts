import { describe, expect, test } from "bun:test";

import { DockviewComponent, type IContentRenderer, type SerializedDockview } from "dockview-react";

import { dropUnregisteredPanels } from "./drop-unregistered-panels";

const noop = () => null;
const components = { terminal: noop, editor: noop };

function panel(id: string, contentComponent: string) {
  return { id, contentComponent, title: id };
}

function leaf(id: string, views: string[], size: number, activeView = views[0]) {
  return { type: "leaf" as const, size, data: { id, views, activeView } };
}

describe("a layout with panels no longer registered", () => {
  test("restores in dockview once they are dropped, and not before", () => {
    const dockview = new DockviewComponent(document.createElement("div"), {
      createComponent: ({ name }): IContentRenderer => {
        if (!Object.hasOwn(components, name)) throw new Error(`Unknown component ${name}`);
        return { element: document.createElement("div"), init: () => {} };
      },
    });
    const saved = {
      grid: {
        root: {
          type: "branch",
          data: [
            leaf("g1", ["agent-1", "t1"], 600, "agent-1"),
            {
              type: "branch",
              size: 400,
              data: [leaf("g2", ["agentdevtools-1"], 400), leaf("g3", ["e1"], 400)],
            },
          ],
        },
        width: 1000,
        height: 800,
        orientation: "HORIZONTAL",
      },
      panels: {
        "agent-1": panel("agent-1", "codingAgent"),
        "agentdevtools-1": panel("agentdevtools-1", "agentDevTools"),
        t1: panel("t1", "terminal"),
        e1: panel("e1", "editor"),
      },
      activeGroup: "g2",
    } as SerializedDockview;

    expect(() => dockview.fromJSON(saved)).toThrow();
    dockview.fromJSON(dropUnregisteredPanels(saved, { components }));
    expect(dockview.panels.map((p) => p.id).sort()).toEqual(["e1", "t1"]);
    expect(dockview.groups.map((g) => g.id).sort()).toEqual(["g1", "g3"]);
    expect(dockview.activeGroup?.id).toBe("g1");
    dockview.dispose();
  });

  test("leaves no empty floating window behind", () => {
    const dockview = new DockviewComponent(document.createElement("div"), {
      createComponent: (): IContentRenderer => ({
        element: document.createElement("div"),
        init: () => {},
      }),
    });
    const saved = {
      grid: {
        root: { type: "branch", data: [leaf("g1", ["t1"], 1000)] },
        width: 1000,
        height: 800,
        orientation: "HORIZONTAL",
      },
      panels: { t1: panel("t1", "terminal"), "agent-1": panel("agent-1", "codingAgent") },
      floatingGroups: [
        {
          data: leaf("float", ["agent-1"], 0).data,
          position: { left: 0, top: 0, width: 100, height: 100 },
        },
      ],
    } as SerializedDockview;

    dockview.fromJSON(dropUnregisteredPanels(saved, { components }));
    expect(dockview.groups.map((g) => g.id)).toEqual(["g1"]);
    dockview.dispose();
  });
});
