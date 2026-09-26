import { describe, expect, test } from "bun:test";

import type { EnrichedProject } from "@/api/project-model";

import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  deriveProject,
} from "./projects";

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

describe("clampSidebarWidth", () => {
  test("keeps widths inside the allowed range", () => {
    expect(clampSidebarWidth(320)).toBe(320);
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 50)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 50)).toBe(SIDEBAR_MAX_WIDTH);
  });

  test("rounds fractional pointer widths", () => {
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  test("falls back to the default for non-finite values", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});
