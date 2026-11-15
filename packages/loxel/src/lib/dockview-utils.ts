import type { SerializedDockview } from "dockview-react";

type SerializedGrid = SerializedDockview["grid"];

/** The top-level grid leaf (a group) holding `panelId`: its position among the root's children and its size. */
export function findGridLeaf(
  grid: SerializedGrid,
  panelId: string,
): { index: number; size: number | undefined } | undefined {
  const nodes = grid.root.data;
  if (!Array.isArray(nodes)) return undefined;
  const index = nodes.findIndex(
    (node) => !Array.isArray(node.data) && node.data.views.includes(panelId),
  );
  if (index === -1) return undefined;
  return { index, size: nodes[index]?.size };
}

/**
 * Detect which side a sidebar panel is on relative to the content panel in a horizontal grid. It
 * goes by the groups' order in the grid rather than their on-screen position, so it holds while
 * the grid is hidden or not yet measured.
 */
export function detectPanelSide(
  grid: SerializedGrid,
  sidebarId: string,
  contentId: string,
): "left" | "right" {
  const sidebar = findGridLeaf(grid, sidebarId);
  const content = findGridLeaf(grid, contentId);
  if (!sidebar || !content) return "left";
  return sidebar.index < content.index ? "left" : "right";
}
