import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { SerializedDockview } from "dockview-react";

import {
  getWorktreeInnerLayout,
  purgeWorktreeCache,
  setWorktreeInnerLayout,
} from "@/store/worktree-cache";
import { purgeWorktreeStores } from "@/store/worktree-store";
import { getWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

mock.module("@/components/panels/BranchPanel", () => ({ BranchPanel: () => null }));
mock.module("./CommitGraph", () => ({ CommitGraph: () => null }));
mock.module("@/queries/use-git-mutations", () => ({
  useCreateBranchMutation: () => ({ mutateAsync: async () => {} }),
}));
mock.module("@/queries/use-repo-queries", () => ({
  useBranchesQuery: () => ({ data: [] }),
  useCommitsQuery: () => ({ data: { commits: [] } }),
}));

const { GraphPanel } = await import("./GraphPanel");

const PANEL_WIDTH = 800;
const PANEL_HEIGHT = 400;
const COLLAPSED_WIDTH = 28;
const BRANCHES_DEFAULT_WIDTH = 220;

/**
 * Stands in for the browser's ResizeObserver, which happy-dom never fires. Like a freshly opened
 * Git panel, the inner dockview mounts at 0×0 and only learns its size from its resize observer.
 */
class FakeResizeObserver {
  static readonly instances = new Set<FakeResizeObserver>();
  private readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.add(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
    FakeResizeObserver.instances.delete(this);
  }
  /** Report every observed element at `width`×`height`. */
  static resizeAll(width: number, height: number): void {
    for (const observer of FakeResizeObserver.instances) {
      const entries = [...observer.targets].map(
        (target) => ({ target, contentRect: { width, height } }) as unknown as ResizeObserverEntry,
      );
      if (entries.length > 0) observer.callback(entries, observer as unknown as ResizeObserver);
    }
  }
}

const originalResizeObserver = globalThis.ResizeObserver;
const originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
beforeAll(() => {
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  // Dockview skips resizes of elements without an offset parent (hidden ones); happy-dom gives none.
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get: () => document.body,
  });
});
afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  if (originalOffsetParent) {
    Object.defineProperty(HTMLElement.prototype, "offsetParent", originalOffsetParent);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "offsetParent");
  }
});

beforeEach(() => {
  useWorktreeStore.setState({ activeWorktreePath: "/repo" });
});

afterEach(() => {
  cleanup();
  purgeWorktreeStores("/repo");
  purgeWorktreeCache("/repo");
});

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** Mount the panel at 0×0, as an inactive Git tab does, and let the mount settle. */
async function mountUnlaidOut(): Promise<void> {
  render(<GraphPanel />);
  await act(nextFrame);
}

/** Mount the panel at 0×0, then give it its real size, as opening the Git panel does. */
async function openGraphPanel(): Promise<void> {
  await mountUnlaidOut();
  act(() => FakeResizeObserver.resizeAll(PANEL_WIDTH, PANEL_HEIGHT));
  // Dockview applies an observed resize on the next animation frame.
  await act(nextFrame);
  await waitFor(() => expect(getWorktreeInnerLayout("graph")).toBeDefined());
}

/** The branches column's laid-out width, read from the splitview view that holds its group. */
function branchesWidth(): number {
  const button = screen.queryByTitle("Hide branches") ?? screen.getByTitle("Show branches");
  const view = button.closest<HTMLElement>(".dv-view");
  if (!view) throw new Error("the branches group is not in a splitview view");
  return Number.parseFloat(view.style.width);
}

/** The saved inner layout, laid out at the panel's size with the branches column `width` wide. */
function layoutWithBranchesWidth(width: number): SerializedDockview {
  const layout = structuredClone(getWorktreeInnerLayout("graph"));
  if (!layout) throw new Error("no inner layout was saved");
  const { root } = layout.grid;
  if (!Array.isArray(root.data)) throw new Error("the inner grid root is not a branch");
  layout.grid.width = PANEL_WIDTH;
  layout.grid.height = PANEL_HEIGHT;
  for (const node of root.data) {
    if (Array.isArray(node.data)) continue;
    node.size = node.data.views.includes("innerBranches") ? width : PANEL_WIDTH - width;
  }
  return layout;
}

describe("GraphPanel", () => {
  // The collapse effect's expand path used to run on mount, while the grid was still 0×0: it
  // dropped the column's minimum to zero, recorded the squeezed width and resized the column to
  // it, so the column stayed at zero once the panel got its real size (#1219).
  test("opens the branches column at its default width on a fresh profile", async () => {
    await openGraphPanel();

    expect(branchesWidth()).toBe(BRANCHES_DEFAULT_WIDTH);
    expect(getWorktreeUI("/repo").getState().branchesPanelSide).toBe("left");
  });

  test("restores the default width when a saved layout has a zero-width branches column", async () => {
    await openGraphPanel();
    const broken = layoutWithBranchesWidth(0);
    cleanup();
    setWorktreeInnerLayout("graph", broken);

    await openGraphPanel();

    expect(branchesWidth()).toBe(BRANCHES_DEFAULT_WIDTH);
  });

  // An inactive Git tab mounts the panel without ever laying it out; the layout it saves holds the
  // column squeezed to its minimum, not a width anyone chose.
  test("opens at the default width after a mount that was never laid out", async () => {
    await mountUnlaidOut();
    cleanup();

    await openGraphPanel();

    expect(branchesWidth()).toBe(BRANCHES_DEFAULT_WIDTH);
  });

  test("keeps the width it was left at through a mount that was never laid out", async () => {
    await openGraphPanel();
    setWorktreeInnerLayout("graph", layoutWithBranchesWidth(300));
    cleanup();
    await mountUnlaidOut();
    cleanup();

    await openGraphPanel();

    expect(branchesWidth()).toBe(300);
  });

  test("reopens the branches column at the width it was left at", async () => {
    await openGraphPanel();
    setWorktreeInnerLayout("graph", layoutWithBranchesWidth(300));
    cleanup();

    await openGraphPanel();

    expect(branchesWidth()).toBe(300);
  });

  test("brings the column back at its last width after hiding and showing it", async () => {
    await openGraphPanel();

    act(() => getWorktreeUI("/repo").getState().toggleBranchesPanel());
    expect(branchesWidth()).toBe(COLLAPSED_WIDTH);
    act(() => getWorktreeUI("/repo").getState().toggleBranchesPanel());
    // Showing it resizes the column on the next frame, once its constraints are relaxed.
    await act(nextFrame);

    expect(branchesWidth()).toBe(BRANCHES_DEFAULT_WIDTH);
  });
});
