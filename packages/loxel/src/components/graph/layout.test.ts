import { describe, expect, test } from "bun:test";

import type { CommitInfo, RefInfo } from "@/api/git-models";

import { calculateLayout, generateEdgePath } from "./layout";

function makeCommit(
  hash: string,
  parents: string[] = [],
  opts: { refs?: RefInfo[]; message?: string; uncommitted?: CommitInfo["uncommitted"] } = {},
): CommitInfo {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    message: opts.message ?? `commit ${hash}`,
    author: "Test",
    authorEmail: "test@test.com",
    authorDate: "2024-01-01T00:00:00Z",
    committer: "Test",
    committerEmail: "test@test.com",
    committerDate: "2024-01-01T00:00:00Z",
    refs: opts.refs ?? [],
    uncommitted: opts.uncommitted,
  };
}

function branchRef(name: string, commit: string): RefInfo {
  return { name, type: "head", commit };
}

describe("calculateLayout", () => {
  test("empty commits returns empty layout", () => {
    const layout = calculateLayout([]);
    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
  });

  test("single commit gets lane 0", () => {
    const layout = calculateLayout([makeCommit("aaa")]);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]!.lane).toBe(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.height).toBe(32);
  });

  test("linear chain uses single lane", () => {
    const commits = [makeCommit("C", ["B"]), makeCommit("B", ["A"]), makeCommit("A")];
    const layout = calculateLayout(commits);
    const lanes = new Set(layout.nodes.map((n) => n.lane));
    expect(lanes.size).toBe(1);
    expect(lanes.has(0)).toBe(true);
    expect(layout.edges).toHaveLength(2);
  });

  test("y positions are sequential", () => {
    const commits = [makeCommit("C", ["B"]), makeCommit("B", ["A"]), makeCommit("A")];
    const layout = calculateLayout(commits);
    expect(layout.nodes[0]!.y).toBe(16);
    expect(layout.nodes[1]!.y).toBe(48);
    expect(layout.nodes[2]!.y).toBe(80);
  });

  test("branch and merge uses two lanes", () => {
    //   M (merge C+E)
    //   |\
    //   | E
    //   | D
    //   C
    //   B
    //   A
    const commits = [
      makeCommit("M", ["C", "E"], { refs: [branchRef("main", "M")] }),
      makeCommit("E", ["D"], { refs: [branchRef("feat", "E")] }),
      makeCommit("D", ["B"]),
      makeCommit("C", ["B"]),
      makeCommit("B", ["A"]),
      makeCommit("A"),
    ];
    const layout = calculateLayout(commits);
    const usedLanes = new Set(layout.nodes.map((n) => n.lane));
    expect(usedLanes.size).toBe(2);
  });

  test("merge commit has two edges", () => {
    const commits = [makeCommit("M", ["A", "B"]), makeCommit("B"), makeCommit("A")];
    const layout = calculateLayout(commits);
    const mergeEdges = layout.edges.filter((e) => e.from.y === layout.nodes[0]!.y);
    expect(mergeEdges).toHaveLength(2);
    expect(mergeEdges.filter((e) => e.isMerge)).toHaveLength(1);
    expect(mergeEdges.filter((e) => !e.isMerge)).toHaveLength(1);
  });

  test("root commit produces no edges", () => {
    const layout = calculateLayout([makeCommit("A")]);
    expect(layout.edges).toHaveLength(0);
  });

  test("branch tip with ref gets branch color", () => {
    const commits = [makeCommit("B", ["A"], { refs: [branchRef("main", "B")] }), makeCommit("A")];
    const layout = calculateLayout(commits);
    expect(layout.nodes[0]!.color).toBeTruthy();
    // Child inherits color from parent that has a ref
    expect(layout.nodes[1]!.color).toBe(layout.nodes[0]!.color);
  });

  test("uncommitted node has dashed edge", () => {
    const commits = [
      makeCommit("uncommitted:path", ["A"], {
        uncommitted: { worktreePath: "/path", branch: "main", stagedCount: 1, unstagedCount: 0 },
      }),
      makeCommit("A", [], { refs: [branchRef("main", "A")] }),
    ];
    const layout = calculateLayout(commits);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]!.dashed).toBe(true);
  });

  test("width scales with max lane count", () => {
    // Three independent branch tips → three lanes
    const commits = [
      makeCommit("C", [], { refs: [branchRef("c", "C")] }),
      makeCommit("B", [], { refs: [branchRef("b", "B")] }),
      makeCommit("A", [], { refs: [branchRef("a", "A")] }),
    ];
    const layout = calculateLayout(commits);
    const maxLane = Math.max(...layout.nodes.map((n) => n.lane));
    expect(layout.width).toBe(20 * 2 + (maxLane + 1) * 24);
  });

  test("height is commits.length * NODE_HEIGHT", () => {
    const commits = [makeCommit("C", ["B"]), makeCommit("B", ["A"]), makeCommit("A")];
    const layout = calculateLayout(commits);
    expect(layout.height).toBe(3 * 32);
  });

  test("merge parent gets a separate lane from first parent", () => {
    //   M (merge A+B)
    //   |  B
    //   A
    //   R
    const commits = [
      makeCommit("M", ["A", "B"], { refs: [branchRef("main", "M")] }),
      makeCommit("B", ["R"], { refs: [branchRef("feat", "B")] }),
      makeCommit("A", ["R"]),
      makeCommit("R"),
    ];
    const layout = calculateLayout(commits);
    const nodeLanes = Object.fromEntries(layout.nodes.map((n) => [n.commit.hash, n.lane]));
    // M and its first parent A share a lane; B is on a different lane
    expect(nodeLanes["M"]).toBe(nodeLanes["A"]);
    expect(nodeLanes["B"]).not.toBe(nodeLanes["M"]);
    // Total lanes used should be exactly 2 (main line + feat)
    const usedLanes = new Set(layout.nodes.map((n) => n.lane));
    expect(usedLanes.size).toBe(2);
  });
});

describe("generateEdgePath", () => {
  test("straight vertical line for same lane", () => {
    const path = generateEdgePath({
      from: { x: 20, y: 16 },
      to: { x: 20, y: 48 },
      color: "red",
      isMerge: false,
    });
    expect(path).toBe("M 20 16 L 20 48");
  });

  test("curved path for lane change right", () => {
    const path = generateEdgePath({
      from: { x: 20, y: 16 },
      to: { x: 44, y: 80 },
      color: "red",
      isMerge: true,
    });
    expect(path).toContain("M 20 16");
    expect(path).toContain("Q");
    expect(path).toContain("44 80");
  });

  test("curved path for lane change left", () => {
    const path = generateEdgePath({
      from: { x: 44, y: 16 },
      to: { x: 20, y: 80 },
      color: "red",
      isMerge: true,
    });
    expect(path).toContain("M 44 16");
    expect(path).toContain("Q");
    expect(path).toContain("20 80");
  });
});
