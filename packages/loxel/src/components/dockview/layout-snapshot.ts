import type { DockviewApi, SerializedDockview } from "dockview-react";

type SerializedGrid = SerializedDockview["grid"];

/** `grid` without its maximized node, which dockview serializes but doesn't declare. */
export function withoutMaximizedNode(grid: SerializedGrid): SerializedGrid {
  const copy: SerializedGrid & { maximizedNode?: unknown } = { ...grid };
  delete copy.maximizedNode;
  return copy;
}

/**
 * The layout to save and restore. A maximized group is left out: restoring one would mount the
 * terminals of the groups it hides at no size, and resize the programs running in them to match.
 */
export function layoutSnapshot(api: DockviewApi): SerializedDockview {
  const layout = api.toJSON();
  return { ...layout, grid: withoutMaximizedNode(layout.grid) };
}
