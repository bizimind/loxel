import type { IDockviewReactProps, SerializedDockview } from "dockview-react";

type GridNode = SerializedDockview["grid"]["root"];
type RegisteredComponents = Pick<IDockviewReactProps, "components" | "tabComponents">;

/**
 * Removes panels whose content or tab component is not registered from a saved layout, so a layout
 * saved by a version that had them still restores. Dockview throws on such a panel, and a failed
 * restore loses the whole layout. Groups left without panels go too, their space to the largest
 * remaining sibling; groups that were already empty stay.
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
  const groupIds = leafGroupIds(root);
  const activeGroup =
    layout.activeGroup && groupIds.includes(layout.activeGroup) ? layout.activeGroup : groupIds[0];
  // A maximized node is addressed by its location in the grid, which pruning may have moved.
  const grid: SerializedDockview["grid"] & { maximizedNode?: unknown } = { ...layout.grid, root };
  delete grid.maximizedNode;
  return { ...layout, grid, panels, activeGroup };
}

/** The node without the dropped panels; null when nothing is left of it. */
function pruneNode(node: GridNode, dropped: Set<string>): GridNode | null {
  const { data } = node;
  if (!Array.isArray(data)) {
    const kept = data.views.filter((id) => !dropped.has(id));
    if (kept.length === data.views.length) return node;
    if (kept.length === 0) return null;
    const activeView =
      data.activeView && kept.includes(data.activeView) ? data.activeView : kept.at(-1);
    return { ...node, data: { ...data, views: kept, activeView } };
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

function leafGroupIds({ data }: GridNode): string[] {
  return Array.isArray(data) ? data.flatMap(leafGroupIds) : [data.id];
}
