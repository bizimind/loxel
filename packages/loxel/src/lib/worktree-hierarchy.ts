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
  /** Hidden itself or below a hidden worktree */
  hidden: boolean;
}

/**
 * The nested list as the sidebar shows it: depth-first, siblings in the order of `ordered`, and
 * the subtrees of collapsed worktrees left out.
 */
export function buildWorktreeRows<T extends HierarchyMember>(
  ordered: readonly T[],
  collapsedPaths: ReadonlySet<string>,
  hiddenPaths: ReadonlySet<string>,
): WorktreeRow<T>[] {
  const parents = resolveParents(ordered);
  const children = childrenByParent(parents);
  const byPath = new Map(ordered.map((wt) => [wt.path, wt]));
  const rows: WorktreeRow<T>[] = [];

  const visit = (wt: T, depth: number, parentHidden: boolean) => {
    const collapsed = collapsedPaths.has(wt.path);
    const hidden = parentHidden || hiddenPaths.has(wt.path);
    rows.push({
      wt,
      depth,
      parent: parents.get(wt.path) ?? null,
      descendantCount: descendantsOf(wt.path, children).length,
      collapsed,
      hidden,
    });
    if (collapsed) return;
    for (const child of children.get(wt.path) ?? []) {
      const entry = byPath.get(child);
      if (entry) visit(entry, depth + 1, hidden);
    }
  };

  for (const wt of ordered) if (parents.get(wt.path) === null) visit(wt, 0, false);
  return rows;
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
