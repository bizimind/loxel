import type { DockviewApi, SerializedDockview } from "dockview-react";

/**
 * The layout to save and restore. A maximized group is left out: restoring one would mount the
 * terminals of the groups it hides at no size, and resize the programs running in them to match.
 */
export function layoutSnapshot(api: DockviewApi): SerializedDockview {
  const layout = api.toJSON();
  const grid: SerializedDockview["grid"] & { maximizedNode?: unknown } = { ...layout.grid };
  delete grid.maximizedNode;
  return { ...layout, grid };
}
