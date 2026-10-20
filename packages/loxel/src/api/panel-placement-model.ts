/**
 * Where a newly opened center panel goes: the layout flags of the `loxel` CLI, carried through
 * `POST /api/open` to the window, and the `panel.split.*` actions. Shared by the CLI, the server
 * and the renderer, so it has no dependencies.
 */

/** Directions a panel can be split toward. */
export const SPLIT_DIRECTIONS = ["right", "left", "up", "down"] as const;
export type SplitDirection = (typeof SPLIT_DIRECTIONS)[number];

export function isSplitDirection(value: unknown): value is SplitDirection {
  return SPLIT_DIRECTIONS.some((direction) => direction === value);
}

/**
 * A tab named from outside the window (`loxel --group <tab>`): the tab showing the file at `path`,
 * else a tab titled `name`. `path` is `name` resolved against the CLI's directory; the server drops
 * it when nothing exists there.
 */
export interface PlacementTab {
  name: string;
  path?: string;
}

/**
 * Placement relative to a reference tab: the tab `group` names, else the active one. By default
 * the panel opens as a new tab in the reference tab's group; `split` opens it in a new group on
 * that side of it instead, and `replace` puts it in the reference tab's place and closes that tab.
 * `split` and `replace` are exclusive.
 */
export interface PanelPlacement {
  split?: SplitDirection;
  replace?: boolean;
  group?: PlacementTab;
}

/**
 * How a panel is opened from outside the window (`loxel`): where it goes, and whether it takes
 * focus. With `focus: false` the window stays on its worktree and active tab: the panel is added
 * in the background, and one for another worktree waits until the user switches there. Absent
 * `focus` means true.
 */
export interface PanelOpenOptions {
  placement?: PanelPlacement;
  focus?: boolean;
}

/** Validate a placement from a request body; absent is undefined. Throws on a malformed one. */
export function parsePanelPlacement(value: unknown): PanelPlacement | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("placement must be an object");
  }
  const { split, replace, group } = value as Record<string, unknown>;
  if (split !== undefined && !isSplitDirection(split)) {
    throw new Error(`placement.split must be one of ${SPLIT_DIRECTIONS.join(", ")}`);
  }
  if (replace !== undefined && typeof replace !== "boolean") {
    throw new Error("placement.replace must be a boolean");
  }
  if (split && replace) throw new Error("placement.split and placement.replace are exclusive");
  return {
    ...(split ? { split } : {}),
    ...(replace ? { replace } : {}),
    ...(group === undefined ? {} : { group: parsePlacementTab(group) }),
  };
}

function parsePlacementTab(value: unknown): PlacementTab {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("placement.group must be an object");
  }
  const { name, path } = value as Record<string, unknown>;
  if (typeof name !== "string" || name === "") {
    throw new Error("placement.group.name must be a non-empty string");
  }
  if (path !== undefined && typeof path !== "string") {
    throw new Error("placement.group.path must be a string");
  }
  return { name, ...(path ? { path } : {}) };
}
