import { describe, expect, test } from "bun:test";

import type { EnrichedProject } from "@/api/project-model";

import { deriveProject } from "./projects";

function project(path: string, worktreePaths: string[]): EnrichedProject {
  return {
    id: path,
    path,
    name: path,
    addedAt: "2026-01-01T00:00:00.000Z",
    isBare: false,
    worktreesDir: `${path}/.worktrees`,
    worktrees: worktreePaths.map((worktreePath) => ({
      path: worktreePath,
      branch: "topic",
      commit: "abc",
      isMain: false,
      createdAt: null,
    })),
  };
}

describe("deriveProject", () => {
  test("uses explicit membership for a WT_DIR outside the project", () => {
    const externalWorktree = "/tmp/worktrees/project/topic";
    const owner = project("/repos/project", [externalWorktree]);

    expect(deriveProject(externalWorktree, [owner])).toBe(owner);
  });

  test("does not match a sibling path with the same string prefix", () => {
    expect(deriveProject("/repos/project-other/topic", [project("/repos/project", [])])).toBeNull();
  });
});
