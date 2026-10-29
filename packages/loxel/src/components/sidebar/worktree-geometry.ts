/**
 * Geometry of the sidebar's worktree tree (WorktreeTree.tsx and worktree-tree.css): where icons,
 * knobs and lines sit on the collapsed rail and in the expanded list, and how wide the rail is.
 */
import type { WorktreeEntry } from "@/api/git-models";
import { TREE_INDENT_STEP } from "@/components/tree";
import type { WorktreeNode } from "@/lib/worktree-hierarchy";
import { getWorktreeTrees, type ProjectState } from "@/store/worktrees";

/** Worktree icons are this size at every nesting level. */
export const ICON_PX = 24;
/** Space left of the rail's top-level icons, and right of its deepest ones. */
export const RAIL_PADDING = 10;
/** How far each nesting level steps right on the rail. */
const RAIL_INDENT = 10;
/** Where the expanded list puts a top-level icon: under its project's icon, past the chevron. */
const EXPANDED_LEFT = 36;
/** The rail shows this many nesting levels; deeper worktrees fold into their ancestor's count. */
const RAIL_LEVELS = 3;
/** The knob sits this far inside the parent icon's bottom-left corner; the group's line runs down from it. */
export const KNOB_INSET = 2;

export const iconLeft = (level: number) => RAIL_PADDING + level * RAIL_INDENT;
export const iconLeftExpanded = (level: number) => EXPANDED_LEFT + level * TREE_INDENT_STEP;

/** Whether the rail shows the worktrees nested at `level` + 1. */
export const railShowsBelow = (level: number) => level < RAIL_LEVELS - 1;

/** The collapsed rail's width when the deepest level it shows is `depth`. */
export function railWidth(depth: number): number {
  return RAIL_PADDING * 2 + ICON_PX + depth * RAIL_INDENT;
}

/**
 * The deepest nesting level the collapsed rail shows for a project: open groups only, at most
 * `RAIL_LEVELS`, and the Archive's worktrees one level in when it is open.
 */
export function railDepth(ps: ProjectState, archiveOpen: boolean): number {
  const collapsed = new Set(ps.collapsedPaths);
  const deepest = (nodes: readonly WorktreeNode<WorktreeEntry>[], level: number): number =>
    Math.max(
      -1,
      ...nodes.map((node) =>
        node.children.length > 0 && !collapsed.has(node.wt.path) && railShowsBelow(level)
          ? Math.max(level, deepest(node.children, level + 1))
          : level,
      ),
    );
  const { listed, archived } = getWorktreeTrees(ps);
  return Math.max(0, deepest(listed, 0), archiveOpen ? deepest(archived, 1) : 0);
}
