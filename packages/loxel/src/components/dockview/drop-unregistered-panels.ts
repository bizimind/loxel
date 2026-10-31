import type { IDockviewReactProps, SerializedDockview } from "dockview-react";

type GridNode = SerializedDockview["grid"]["root"];
type GroupPanelViewState = Exclude<GridNode["data"], GridNode[]>;
type RegisteredComponents = Pick<IDockviewReactProps, "components" | "tabComponents">;

/**
 * Removes panels whose content or tab component is not registered from a saved layout, so a layout
 * saved by a version that had them restores without them. Dockview throws on unknown content, and a
 * failed restore loses the whole layout. Groups left without panels go too, floating and popout
 * ones included, a grid group's space going to its largest remaining sibling; groups that were
 * already empty stay.
 */
export function dropUnregisteredPanels(
  layout: SerializedDockview,
  { components, tabComponents }: RegisteredComponents,
): SerializedDockview {
  const isRegistered = (panel: SerializedDockview["panels"][string]) =>
    typeof panel.contentComponent === "string" &&
    Object.hasOwn(components, panel.contentComponent) &&
    (!panel.tabComponent || Object.hasOwn(tabComponents ?? {}, panel.tabComponent));

  const panelEntries = Object.entries(layout.panels);
  const panels = Object.fromEntries(panelEntries.filter(([, panel]) => isRegistered(panel)));
  if (Object.keys(panels).length === panelEntries.length) return layout;

  const dropped = new Set(panelEntries.map(([id]) => id).filter((id) => !(id in panels)));
  const root = pruneNode(layout.grid.root, dropped) ?? { ...layout.grid.root, data: [] };
  const floatingGroups = layout.floatingGroups?.flatMap((w) => pruneWindow(w, dropped) ?? []);
  const popoutGroups = layout.popoutGroups?.flatMap((w) => pruneWindow(w, dropped) ?? []);

  const groupIds = [
    root,
    ...[...(floatingGroups ?? []), ...(popoutGroups ?? [])].flatMap(windowRoots),
  ].flatMap(leafGroupIds);
  const activeGroup =
    layout.activeGroup && groupIds.includes(layout.activeGroup) ? layout.activeGroup : groupIds[0];
  // A maximized node is addressed by its location in the grid, which pruning may have moved.
  const grid: SerializedDockview["grid"] & { maximizedNode?: unknown } = { ...layout.grid, root };
  delete grid.maximizedNode;
  return {
    ...layout,
    grid,
    panels,
    activeGroup,
    ...(floatingGroups && { floatingGroups }),
    ...(popoutGroups && { popoutGroups }),
  };
}

/** The group without the dropped panels, itself if it held none; null when it held nothing else. */
function pruneGroup(group: GroupPanelViewState, dropped: Set<string>): GroupPanelViewState | null {
  const views = group.views.filter((id) => !dropped.has(id));
  if (views.length === group.views.length) return group;
  if (views.length === 0) return null;
  const activeView =
    group.activeView && views.includes(group.activeView) ? group.activeView : views.at(-1);
  return { ...group, views, activeView };
}

/** The node without the dropped panels; null when nothing is left of it. */
function pruneNode(node: GridNode, dropped: Set<string>): GridNode | null {
  const { data } = node;
  if (!Array.isArray(data)) {
    const group = pruneGroup(data, dropped);
    return group && { ...node, data: group };
  }

  const pruned = data.map((child) => pruneNode(child, dropped));
  const kept = pruned.filter((child) => child !== null);
  if (kept.length === 0) return null;

  const shownSize = (child: GridNode) => (child.visible === false ? 0 : (child.size ?? 0));
  const freed = data
    .filter((_, index) => pruned[index] === null)
    .reduce((total, child) => total + shownSize(child), 0);
  const largest = kept.reduce((a, b) => (shownSize(b) > shownSize(a) ? b : a));
  return {
    ...node,
    data: kept.map((child) =>
      child === largest && shownSize(child) > 0
        ? { ...child, size: shownSize(child) + freed }
        : child,
    ),
  };
}

/** A floating or popout window: one group in `data`, or several in a nested `grid`. */
interface DetachedWindow {
  data?: GroupPanelViewState;
  grid?: { root: GridNode };
}

function pruneWindow<T extends DetachedWindow>(window: T, dropped: Set<string>): T | null {
  if (window.grid) {
    const root = pruneNode(window.grid.root, dropped);
    return root && { ...window, grid: { ...window.grid, root } };
  }
  if (!window.data) return window;
  const data = pruneGroup(window.data, dropped);
  return data && { ...window, data };
}

function windowRoots({ data, grid }: DetachedWindow): GridNode[] {
  if (grid) return [grid.root];
  return data ? [{ type: "leaf", data }] : [];
}

function leafGroupIds({ data }: GridNode): string[] {
  return Array.isArray(data) ? data.flatMap(leafGroupIds) : [data.id];
}
