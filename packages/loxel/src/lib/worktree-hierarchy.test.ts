import { describe, expect, test } from "bun:test";

import {
  archivedSet,
  buildWorktreeRows,
  buildWorktreeTree,
  childrenByParent,
  descendantsOf,
  moveInOrder,
  resolveParents,
  resolveRowDrop,
  type HierarchyMember,
} from "./worktree-hierarchy";

function wt(path: string, wtId?: string, parentWtId?: string): HierarchyMember {
  return { path, ...(wtId ? { wtId } : {}), ...(parentWtId ? { parentWtId } : {}) };
}

describe("resolveParents", () => {
  test("nests by parent id and leaves unknown and self references at the top level", () => {
    const parents = resolveParents([
      wt("/a", "a"),
      wt("/b", "b", "a"),
      wt("/c", "c", "missing"),
      wt("/d", "d", "d"),
      wt("/e", undefined, "b"),
    ]);
    expect(Object.fromEntries(parents)).toEqual({
      "/a": null,
      "/b": "/a",
      "/c": null,
      "/d": null,
      "/e": "/b",
    });
  });

  test("puts every worktree on a cycle at the top level, keeping the ones hanging off it", () => {
    const parents = resolveParents([
      wt("/a", "a", "c"),
      wt("/b", "b", "a"),
      wt("/c", "c", "b"),
      wt("/x", "x", "b"),
    ]);
    expect(Object.fromEntries(parents)).toEqual({ "/a": null, "/b": null, "/c": null, "/x": "/b" });
  });
});

describe("descendantsOf", () => {
  test("lists every level, parents before children", () => {
    const children = childrenByParent(
      resolveParents([wt("/a", "a"), wt("/b", "b", "a"), wt("/c", "c", "b"), wt("/d", "d", "a")]),
    );
    expect(descendantsOf("/a", children)).toEqual(["/b", "/d", "/c"]);
    expect(descendantsOf("/c", children)).toEqual([]);
  });
});

describe("buildWorktreeRows", () => {
  const ordered = [wt("/a", "a"), wt("/c", "c", "a"), wt("/z", "z"), wt("/b", "b", "a")];

  test("lists depth-first, siblings in the given order", () => {
    const rows = buildWorktreeRows(ordered, new Set());
    expect(rows.map((row) => [row.wt.path, row.depth, row.parent, row.descendantCount])).toEqual([
      ["/a", 0, null, 2],
      ["/c", 1, "/a", 0],
      ["/b", 1, "/a", 0],
      ["/z", 0, null, 0],
    ]);
  });

  test("leaves out collapsed subtrees", () => {
    expect(buildWorktreeRows(ordered, new Set(["/a"])).map((row) => row.wt.path)).toEqual([
      "/a",
      "/z",
    ]);
  });
});

describe("buildWorktreeTree", () => {
  test("nests children under their parent with depths and descendant counts", () => {
    const tree = buildWorktreeTree([wt("/a", "a"), wt("/b", "b", "a"), wt("/c", "c", "b")]);
    const flat = (nodes: typeof tree): unknown[] =>
      nodes.flatMap((node) => [
        [node.wt.path, node.depth, node.descendantCount],
        ...flat(node.children),
      ]);
    expect(flat(tree)).toEqual([
      ["/a", 0, 2],
      ["/b", 1, 1],
      ["/c", 2, 0],
    ]);
  });

  test("puts a worktree whose parent is not listed at the top level", () => {
    const tree = buildWorktreeTree([wt("/b", "b", "a")]);
    expect(tree.map((node) => [node.wt.path, node.depth])).toEqual([["/b", 0]]);
  });
});

describe("archivedSet", () => {
  const worktrees = [wt("/a", "a"), wt("/b", "b", "a"), wt("/c", "c", "b"), wt("/z", "z")];

  test("archives a worktree with everything nested below it", () => {
    expect([...archivedSet(worktrees, ["/b"])].toSorted()).toEqual(["/b", "/c"]);
  });

  test("ignores paths of worktrees that are gone", () => {
    expect([...archivedSet(worktrees, ["/gone", "/z"])]).toEqual(["/z"]);
  });
});

describe("moveInOrder", () => {
  test("places the moved path before or after the target", () => {
    expect(moveInOrder(["/a", "/b", "/c"], "/c", "/a", "before")).toEqual(["/c", "/a", "/b"]);
    expect(moveInOrder(["/a", "/b", "/c"], "/a", "/b", "after")).toEqual(["/b", "/a", "/c"]);
  });

  test("leaves the order alone for an unknown target or a move onto itself", () => {
    expect(moveInOrder(["/a", "/b"], "/a", "/x", "after")).toEqual(["/a", "/b"]);
    expect(moveInOrder(["/a", "/b"], "/a", "/a", "after")).toEqual(["/a", "/b"]);
  });
});

describe("resolveRowDrop", () => {
  // /a
  //   /b
  //     /c
  // /d
  const rows = buildWorktreeRows(
    [wt("/a", "a"), wt("/b", "b", "a"), wt("/c", "c", "b"), wt("/d", "d")],
    new Set(),
  );

  test("the middle of a row nests into it, its edges place the worktree beside it", () => {
    expect(resolveRowDrop(rows, "/d", "/b", 0.5, true)).toEqual({
      path: "/b",
      zone: "inside",
      parent: "/b",
    });
    expect(resolveRowDrop(rows, "/d", "/c", 0.1, true)).toEqual({
      path: "/c",
      zone: "before",
      parent: "/b",
    });
    expect(resolveRowDrop(rows, "/d", "/c", 0.9, true)).toEqual({
      path: "/c",
      zone: "after",
      parent: "/b",
    });
  });

  test("drags a nested worktree out to the top level", () => {
    expect(resolveRowDrop(rows, "/c", "/d", 0.9, true)).toEqual({
      path: "/d",
      zone: "after",
      parent: null,
    });
    expect(resolveRowDrop(rows, "/c", "/a", 0.1, true)).toEqual({
      path: "/a",
      zone: "before",
      parent: null,
    });
  });

  test("dropping after an expanded parent puts the worktree first among its children", () => {
    expect(resolveRowDrop(rows, "/d", "/b", 0.9, true)).toEqual({
      path: "/c",
      zone: "before",
      parent: "/b",
    });
    expect(resolveRowDrop(rows, "/c", "/b", 0.9, true)).toBeNull();
  });

  test("never drops a worktree under itself", () => {
    expect(resolveRowDrop(rows, "/a", "/c", 0.5, true)).toBeNull();
    expect(resolveRowDrop(rows, "/a", "/c", 0.1, true)).toBeNull();
  });

  test("the middle of its own parent's row places it beside the parent instead", () => {
    expect(resolveRowDrop(rows, "/c", "/b", 0.3, true)).toEqual({
      path: "/b",
      zone: "before",
      parent: "/a",
    });
  });

  test("without nesting, only reorders worktrees that share a parent", () => {
    const flat = buildWorktreeRows([wt("/a"), wt("/b")], new Set());
    expect(resolveRowDrop(flat, "/b", "/a", 0.5, false)).toEqual({
      path: "/a",
      zone: "after",
      parent: null,
    });
    expect(resolveRowDrop(rows, "/d", "/c", 0.1, false)).toBeNull();
  });
});
