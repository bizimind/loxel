import type { CommitInfo } from "@/api/git-models";

import { getBranchColor } from "@/lib/colors";

export interface LayoutNode {
  commit: CommitInfo;
  x: number;
  y: number;
  lane: number;
  color: string;
}

export interface LayoutEdge {
  from: { x: number; y: number };
  to: { x: number; y: number };
  color: string;
  isMerge: boolean;
  dashed?: boolean;
}

export interface GraphLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

/**
 * Get the primary branch name from a commit's refs.
 * Prioritizes: HEAD > local branches > remote branches > tags
 */
function getPrimaryBranchName(commit: CommitInfo): string | null {
  const ref =
    commit.refs.find((r) => r.type === "HEAD") ??
    commit.refs.find((r) => r.type === "head") ??
    commit.refs.find((r) => r.type === "remote") ??
    commit.refs.find((r) => r.type === "tag");
  return ref?.name ?? null;
}

/**
 * Calculate graph layout using an improved two-pass swim lane algorithm.
 *
 * Pass 1: Build children relationships and determine lane occupancy ranges
 * Pass 2: Assign lanes preferring leftmost available to minimize width
 *
 * Color propagation: Branch tips (commits with refs) get colors from getBranchColor().
 * Other commits inherit color from their child, maintaining branch identity.
 */
export function calculateLayout(commits: CommitInfo[]): GraphLayout {
  const NODE_HEIGHT = 32;
  const LANE_WIDTH = 24;
  const PADDING_LEFT = 20;

  if (commits.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  // Build commit index for quick lookup
  const commitIndex = new Map<string, number>();
  commits.forEach((c, i) => commitIndex.set(c.hash, i));

  // Pass 1: Build children relationships (who has me as parent)
  const children = new Map<string, string[]>();
  for (const commit of commits) {
    for (const parentHash of commit.parents) {
      const list = children.get(parentHash);
      if (list) {
        list.push(commit.hash);
      } else {
        children.set(parentHash, [commit.hash]);
      }
    }
  }

  // Track active lanes: maps lane number to the commit hash that "owns" it until we reach that commit
  // Lane is occupied from the row where it's assigned until the row of the owning commit
  const activeLanes = new Map<number, string>();
  const commitLanes = new Map<string, number>();
  const commitColors = new Map<string, string>();
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];

  // Helper to find the leftmost free lane
  function findLeftmostFreeLane(): number {
    let lane = 0;
    while (activeLanes.has(lane)) {
      lane++;
    }
    return lane;
  }

  // Helper to allocate a lane, preferring leftmost available
  function allocateLane(ownerHash: string): number {
    const lane = findLeftmostFreeLane();
    activeLanes.set(lane, ownerHash);
    return lane;
  }

  // Helper to free a lane
  function freeLane(lane: number): void {
    activeLanes.delete(lane);
  }

  // Pass 2: Process commits in topological order (newest first in git log)
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    if (!commit) continue;

    const y = i * NODE_HEIGHT + NODE_HEIGHT / 2;

    // Determine this commit's lane
    let lane = commitLanes.get(commit.hash);

    if (lane === undefined) {
      // This is a branch tip (no children in our visible commits) - allocate new lane
      lane = allocateLane(commit.hash);
    }
    // Note: If we inherited a lane from a child, the lane stays occupied until we decide to free it below

    commitLanes.set(commit.hash, lane);
    const x = PADDING_LEFT + lane * LANE_WIDTH;

    // Determine color: from refs (branch tip) or inherit from child
    let color: string;
    if (commit.uncommitted) {
      // Virtual uncommitted node: inherit color from parent commit's branch
      const parentHash = commit.parents[0];
      const parentIdx = parentHash ? commitIndex.get(parentHash) : undefined;
      const parentCommit = parentIdx !== undefined ? commits[parentIdx] : undefined;
      const parentBranch = parentCommit ? getPrimaryBranchName(parentCommit) : null;
      color = parentBranch ? getBranchColor(parentBranch) : getBranchColor(`lane-${lane}`);
    } else {
      const branchName = getPrimaryBranchName(commit);
      if (branchName) {
        color = getBranchColor(branchName);
      } else {
        // Inherit color from child (commits that have this as first parent)
        const childHashes = children.get(commit.hash) ?? [];
        const firstChild = childHashes[0];
        const childColor = firstChild ? commitColors.get(firstChild) : undefined;
        color = childColor ?? getBranchColor(`lane-${lane}`);
      }
    }
    commitColors.set(commit.hash, color);

    nodes.push({ commit, x, y, lane, color });

    const parents = commit.parents;

    if (parents.length === 0) {
      // Root commit - free the lane
      freeLane(lane);
    } else {
      // Process parents
      const firstParent = parents[0];

      // First parent continues in the same lane
      if (firstParent) {
        const parentIdx = commitIndex.get(firstParent);
        if (parentIdx !== undefined) {
          // Reserve this lane for the first parent if not already assigned
          const existingLane = commitLanes.get(firstParent);
          if (existingLane === undefined) {
            commitLanes.set(firstParent, lane);
            activeLanes.set(lane, firstParent);
          } else if (existingLane !== lane) {
            // First parent already has a different lane (merge point) - free current lane
            freeLane(lane);
          }
          // If first parent has same lane, lane stays occupied (continues through)

          // Draw edge to first parent
          const parentY = parentIdx * NODE_HEIGHT + NODE_HEIGHT / 2;
          const parentLane = commitLanes.get(firstParent) ?? lane;
          const parentX = PADDING_LEFT + parentLane * LANE_WIDTH;

          edges.push({
            from: { x, y },
            to: { x: parentX, y: parentY },
            color,
            isMerge: false,
            dashed: !!commit.uncommitted,
          });
        } else {
          // Parent not in visible commits - free the lane
          freeLane(lane);
        }
      }

      // Secondary parents (merge commits)
      for (let p = 1; p < parents.length; p++) {
        const parentHash = parents[p];
        if (!parentHash) continue;

        const parentIdx = commitIndex.get(parentHash);
        if (parentIdx === undefined) continue;

        // Find or assign lane for merge parent
        let parentLane = commitLanes.get(parentHash);
        if (parentLane === undefined) {
          // Need a new lane for this merge parent - prefer leftmost
          parentLane = allocateLane(parentHash);
          commitLanes.set(parentHash, parentLane);
        }

        const parentX = PADDING_LEFT + parentLane * LANE_WIDTH;
        const parentY = parentIdx * NODE_HEIGHT + NODE_HEIGHT / 2;
        // Use the parent's color if already assigned, otherwise derive from branch
        const parentColor = commitColors.get(parentHash) ?? getBranchColor(`lane-${parentLane}`);

        edges.push({
          from: { x, y },
          to: { x: parentX, y: parentY },
          color: parentColor,
          isMerge: true,
        });
      }
    }
  }

  const maxLane = nodes.length > 0 ? Math.max(...nodes.map((n) => n.lane)) : 0;
  const width = PADDING_LEFT * 2 + (maxLane + 1) * LANE_WIDTH;
  const height = commits.length * NODE_HEIGHT;

  return { nodes, edges, width, height };
}

/**
 * Generate SVG path for an edge with curves at corners.
 *
 * For lane changes, curves at the TOP (near source) to avoid visual confusion
 * with other commits on the same lane. This matches git log --graph behavior
 * where branches curve immediately after diverging.
 */
export function generateEdgePath(edge: LayoutEdge): string {
  const { from, to } = edge;

  if (from.x === to.x) {
    // Straight vertical line
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  }

  // Curved path for lane changes - curve at TOP near source
  const curveRadius = 8;
  const curveY = from.y + curveRadius; // Curve starts just below source

  if (from.x < to.x) {
    // Going right: curve right at top, then straight down
    return `M ${from.x} ${from.y}
            L ${from.x} ${curveY}
            Q ${from.x} ${curveY + curveRadius} ${from.x + curveRadius} ${curveY + curveRadius}
            L ${to.x - curveRadius} ${curveY + curveRadius}
            Q ${to.x} ${curveY + curveRadius} ${to.x} ${curveY + curveRadius * 2}
            L ${to.x} ${to.y}`;
  }

  // Going left: curve left at top, then straight down
  return `M ${from.x} ${from.y}
          L ${from.x} ${curveY}
          Q ${from.x} ${curveY + curveRadius} ${from.x - curveRadius} ${curveY + curveRadius}
          L ${to.x + curveRadius} ${curveY + curveRadius}
          Q ${to.x} ${curveY + curveRadius} ${to.x} ${curveY + curveRadius * 2}
          L ${to.x} ${to.y}`;
}
