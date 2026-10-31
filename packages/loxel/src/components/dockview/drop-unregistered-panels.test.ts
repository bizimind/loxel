import { describe, expect, test } from "bun:test";

import type { SerializedDockview } from "dockview-react";

import { dropUnregisteredPanels } from "./drop-unregistered-panels";

const noop = () => null;
const REGISTERED = {
  components: { terminal: noop, editor: noop, centerHost: noop },
  tabComponents: { terminalTab: noop },
};

function panel(id: string, contentComponent: string, tabComponent?: string) {
  return { id, contentComponent, tabComponent, title: id };
}

function leaf(id: string, views: string[], size: number, activeView = views[0]) {
  return { type: "leaf" as const, size, data: { id, views, activeView } };
}

function layout(
  rootChildren: SerializedDockview["grid"]["root"][],
  panels: ReturnType<typeof panel>[],
  activeGroup?: string,
): SerializedDockview {
  return {
    grid: {
      root: { type: "branch", data: rootChildren },
      width: 1000,
      height: 800,
      orientation: "HORIZONTAL",
    } as SerializedDockview["grid"],
    panels: Object.fromEntries(panels.map((p) => [p.id, p])),
    activeGroup,
  };
}

describe("dropUnregisteredPanels", () => {
  test("returns a layout with nothing to drop as it is", () => {
    const saved = layout(
      [leaf("g1", ["t1"], 1000), leaf("empty", [], 0)],
      [panel("t1", "terminal", "terminalTab")],
      "g1",
    );
    expect(dropUnregisteredPanels(saved, REGISTERED)).toBe(saved);
  });

  test("drops a panel with an unknown content component or tab, next to panels that stay", () => {
    const saved = layout(
      [leaf("g1", ["agent-1", "t1", "agentdevtools-1", "e1"], 1000, "agent-1")],
      [
        panel("agent-1", "codingAgent", "codingAgentTab"),
        panel("t1", "terminal", "terminalTab"),
        panel("agentdevtools-1", "editor", "agentDevToolsTab"),
        panel("e1", "editor"),
      ],
      "g1",
    );
    const result = dropUnregisteredPanels(saved, REGISTERED);
    expect(Object.keys(result.panels)).toEqual(["t1", "e1"]);
    expect(result.grid.root.data).toEqual([
      expect.objectContaining({ data: { id: "g1", views: ["t1", "e1"], activeView: "e1" } }),
    ]);
    expect(result.activeGroup).toBe("g1");
  });

  test("keeps the active view when it stays", () => {
    const saved = layout(
      [leaf("g1", ["t1", "agent-1", "e1"], 1000, "t1")],
      [panel("t1", "terminal"), panel("agent-1", "codingAgent"), panel("e1", "editor")],
    );
    const [group] = dropUnregisteredPanels(saved, REGISTERED).grid.root.data as { data: unknown }[];
    expect(group?.data).toEqual({ id: "g1", views: ["t1", "e1"], activeView: "t1" });
  });

  test("removes a group it empties, gives its space to the largest sibling", () => {
    const saved = layout(
      [leaf("left", ["e1"], 200), leaf("center", ["t1"], 500), leaf("right", ["forkTree"], 300)],
      [panel("e1", "editor"), panel("t1", "terminal"), panel("forkTree", "forkTree")],
      "right",
    );
    const result = dropUnregisteredPanels(saved, REGISTERED);
    expect(result.grid.root.data).toEqual([
      expect.objectContaining({ size: 200, data: expect.objectContaining({ id: "left" }) }),
      expect.objectContaining({ size: 800, data: expect.objectContaining({ id: "center" }) }),
    ]);
    expect(result.activeGroup).toBe("left");
  });

  test("removes a nested branch it empties, and leaves empty groups it didn't empty", () => {
    const saved = layout(
      [
        leaf("center", ["t1"], 600),
        leaf("was-empty", [], 100),
        {
          type: "branch",
          size: 300,
          data: [leaf("a", ["agent-1"], 400), leaf("b", ["agent-2"], 400)],
        },
      ],
      [panel("t1", "terminal"), panel("agent-1", "codingAgent"), panel("agent-2", "codingAgent")],
    );
    const result = dropUnregisteredPanels(saved, REGISTERED);
    expect(result.grid.root.data).toEqual([
      expect.objectContaining({ size: 900 }),
      expect.objectContaining({ size: 100 }),
    ]);
  });

  test("a layout of nothing but dropped panels leaves an empty grid", () => {
    const saved = layout([leaf("g1", ["agent-1"], 1000)], [panel("agent-1", "codingAgent")], "g1");
    const result = dropUnregisteredPanels(saved, REGISTERED);
    expect(result.grid.root.data).toEqual([]);
    expect(result.panels).toEqual({});
    expect(result.activeGroup).toBeUndefined();
  });

  test("prunes floating and popout windows, dropping the ones it empties", () => {
    const position = { left: 0, top: 0, width: 100, height: 100 };
    const saved: SerializedDockview = {
      ...layout(
        [leaf("g1", ["t1"], 1000)],
        [panel("t1", "terminal"), panel("e1", "editor"), panel("agent-1", "codingAgent")],
        "float",
      ),
      floatingGroups: [
        { data: leaf("float", ["agent-1", "e1"], 0, "agent-1").data, position },
        { data: leaf("gone", ["agent-1"], 0).data, position },
        {
          grid: {
            root: { type: "branch", data: [leaf("nested", ["agent-1"], 100)] },
            width: 100,
            height: 100,
            orientation: "HORIZONTAL",
          } as NonNullable<NonNullable<SerializedDockview["floatingGroups"]>[number]["grid"]>,
          position,
        },
      ],
      popoutGroups: [{ data: leaf("pop", ["agent-1"], 0).data, position }],
    };
    const result = dropUnregisteredPanels(saved, REGISTERED);
    expect(result.floatingGroups).toEqual([
      { data: { id: "float", views: ["e1"], activeView: "e1" }, position },
    ]);
    expect(result.popoutGroups).toEqual([]);
    expect(result.activeGroup).toBe("float");
  });

  test("forgets a maximized node, whose location may have moved", () => {
    const saved = layout(
      [leaf("g1", ["t1"], 500), leaf("g2", ["agent-1"], 500)],
      [panel("t1", "terminal"), panel("agent-1", "codingAgent")],
    );
    const grid = saved.grid as typeof saved.grid & { maximizedNode?: unknown };
    grid.maximizedNode = { location: [1] };
    expect(dropUnregisteredPanels(saved, REGISTERED).grid).not.toHaveProperty("maximizedNode");
  });
});
