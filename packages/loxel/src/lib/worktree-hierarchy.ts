/**
 * Worktree nesting: which worktree is under which, from the parent ids worktrees store in their
 * metadata (`loxel-parent-wt`). Pure, shared by the server (removing a subtree) and the sidebar.
 */

/** The fields of a worktree that place it in the hierarchy. */
export interface HierarchyMember {
  path: string;
  /** The worktree's stable id (`wt-id`) */
  wtId?: string;
  /** The `wt-id` of the worktree it is nested under */
  parentWtId?: string;
}

/**
 * Each worktree's parent path, null for a top-level one. A parent id that matches no listed
 * worktree, or the worktree itself, leaves it at the top level, and so does being on a cycle
 * (parent links written by hand can form one): every worktree on it becomes top-level.
 */
export function resolveParents(worktrees: readonly HierarchyMember[]): Map<string, string | null> {
  const pathById = new Map<string, string>();
  for (const wt of worktrees) if (wt.wtId) pathById.set(wt.wtId, wt.path);

  const parents = new Map<string, string | null>();
  for (const wt of worktrees) {
    const parent = wt.parentWtId ? pathById.get(wt.parentWtId) : undefined;
    parents.set(wt.path, parent !== undefined && parent !== wt.path ? parent : null);
  }

  for (const wt of worktrees) {
    const chain = new Set<string>();
    let current: string | null = wt.path;
    while (current !== null && !chain.has(current)) {
      chain.add(current);
      current = parents.get(current) ?? null;
    }
    if (current === null) continue;
    // `current` is on a cycle: cut every link around it.
    const start: string = current;
    let node: string = start;
    do {
      const next: string | null = parents.get(node) ?? null;
      parents.set(node, null);
      node = next ?? start;
    } while (node !== start);
  }
  return parents;
}

/** Each worktree's children, in the order of `parents`' keys; worktrees without any are absent. */
export function childrenByParent(
  parents: ReadonlyMap<string, string | null>,
): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const [path, parent] of parents) {
    if (parent === null) continue;
    const siblings = children.get(parent);
    if (siblings) siblings.push(path);
    else children.set(parent, [path]);
  }
  return children;
}

/** Every worktree below `path`, parents before their children. */
export function descendantsOf(
  path: string,
  children: ReadonlyMap<string, readonly string[]>,
): string[] {
  const result: string[] = [];
  const queue = [...(children.get(path) ?? [])];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    result.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return result;
}

/** One visible row of the nested worktree list. */
export interface WorktreeRow<T extends HierarchyMember> {
  wt: T;
  depth: number;
  /** Parent path, null at the top level */
  parent: string | null;
  /** Number of worktrees below this one, at any depth */
  descendantCount: number;
  collapsed: boolean;
}

/** A worktree with the worktrees nested below it, for rendering the list as a tree. */
export interface WorktreeNode<T extends HierarchyMember> {
  wt: T;
  depth: number;
  children: WorktreeNode<T>[];
  /** Number of worktrees below this one, at any depth */
  descendantCount: number;
}

/** The nested list as a tree: siblings in the order of `ordered`, nothing left out. */
export function buildWorktreeTree<T extends HierarchyMember>(
  ordered: readonly T[],
): WorktreeNode<T>[] {
  const parents = resolveParents(ordered);
  const children = childrenByParent(parents);
  const byPath = new Map(ordered.map((wt) => [wt.path, wt]));

  const build = (wt: T, depth: number): WorktreeNode<T> => {
    const nested = (children.get(wt.path) ?? []).flatMap((path) => {
      const entry = byPath.get(path);
      return entry ? [build(entry, depth + 1)] : [];
    });
    const descendantCount = nested.reduce((sum, node) => sum + 1 + node.descendantCount, 0);
    return { wt, depth, children: nested, descendantCount };
  };

  return ordered.filter((wt) => parents.get(wt.path) === null).map((wt) => build(wt, 0));
}

/**
 * `nodes` as rows, depth-first, listing a node's children only where `isOpen` says so. Rows get
 * `depth + levelOffset` (for trees drawn one level in, like the Archive group's) and the parent
 * they are shown under, null for the given nodes.
 */
export function flattenTree<T extends HierarchyMember>(
  nodes: readonly WorktreeNode<T>[],
  isOpen: (node: WorktreeNode<T>) => boolean,
  levelOffset = 0,
  parent: string | null = null,
): WorktreeRow<T>[] {
  return nodes.flatMap((node) => {
    const open = node.children.length > 0 && isOpen(node);
    const row: WorktreeRow<T> = {
      wt: node.wt,
      depth: node.depth + levelOffset,
      parent,
      descendantCount: node.descendantCount,
      collapsed: node.children.length > 0 && !open,
    };
    if (!open) return [row];
    return [row, ...flattenTree(node.children, isOpen, levelOffset, node.wt.path)];
  });
}

/**
 * The nested list as the sidebar shows it: depth-first, siblings in the order of `ordered`, and
 * the subtrees of collapsed worktrees left out.
 */
export function buildWorktreeRows<T extends HierarchyMember>(
  ordered: readonly T[],
  collapsedPaths: ReadonlySet<string>,
): WorktreeRow<T>[] {
  return flattenTree(buildWorktreeTree(ordered), (node) => !collapsedPaths.has(node.wt.path));
}

/**
 * The worktrees that are archived: each path in `archivedPaths` with everything nested below it,
 * since archiving moves a worktree together with its nested ones.
 */
export function archivedSet(
  worktrees: readonly HierarchyMember[],
  archivedPaths: readonly string[],
): Set<string> {
  const children = childrenByParent(resolveParents(worktrees));
  const known = new Set(worktrees.map((wt) => wt.path));
  const archived = new Set<string>();
  for (const path of archivedPaths) {
    if (!known.has(path)) continue;
    archived.add(path);
    for (const below of descendantsOf(path, children)) archived.add(below);
  }
  return archived;
}

/**
 * `orderedPaths` with `moved` placed right before or after `target`. Worktrees keep one display
 * order across all levels, so moving one among its siblings leaves the others where they were.
 */
export function moveInOrder(
  orderedPaths: readonly string[],
  moved: string,
  target: string,
  side: "before" | "after",
): string[] {
  if (moved === target) return [...orderedPaths];
  const rest = orderedPaths.filter((path) => path !== moved);
  const index = rest.indexOf(target);
  if (index === -1) return [...orderedPaths];
  rest.splice(side === "before" ? index : index + 1, 0, moved);
  return rest;
}

/** Where a dragged worktree lands: nested inside a row, or just before or after it. */
export interface RowDrop {
  path: string;
  zone: "before" | "after" | "inside";
  /** The parent the dragged worktree ends up under, null for the top level */
  parent: string | null;
}

/**
 * Where dropping `moved` at `ratio` of `target`'s row height (0 top, 1 bottom) puts it, or null
 * where the drop would do nothing or put a worktree under itself. With `nesting` on, the middle
 * half of a row nests into it; otherwise, and at the edges, the worktree goes before or after the
 * row as its sibling, under the row's parent. Dropping after an expanded parent puts it first
 * among that parent's children, which is where the row boundary is.
 */
export function resolveRowDrop<T extends HierarchyMember>(
  rows: readonly WorktreeRow<T>[],
  moved: string,
  target: string,
  ratio: number,
  nesting: boolean,
): RowDrop | null {
  const movedRow = rows.find((row) => row.wt.path === moved);
  const targetIndex = rows.findIndex((row) => row.wt.path === target);
  const targetRow = rows[targetIndex];
  if (!movedRow || !targetRow || moved === target) return null;

  // A visible target under `moved` has every row between them visible too.
  const subtree = new Set([moved]);
  for (const row of rows) {
    if (row.parent !== null && subtree.has(row.parent)) subtree.add(row.wt.path);
  }
  if (subtree.has(target)) return null;

  const middle = ratio > 0.25 && ratio < 0.75;
  if (nesting && middle && movedRow.parent !== target) {
    return { path: target, zone: "inside", parent: target };
  }

  const next = rows[targetIndex + 1];
  const drop: RowDrop =
    ratio < 0.5
      ? { path: target, zone: "before", parent: targetRow.parent }
      : next?.parent === target
        ? { path: next.wt.path, zone: "before", parent: target }
        : { path: target, zone: "after", parent: targetRow.parent };
  if (drop.path === moved) return null;
  // Changing a worktree's parent writes its metadata, which needs nesting on.
  if (!nesting && drop.parent !== movedRow.parent) return null;
  return drop;
}
