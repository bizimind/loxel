import { describe, expect, test } from "bun:test";

import { externalFolderConflict, findOwningProject } from "./server-state";

const repo = { cwd: "/home/me/repo", worktreesDir: "/home/me/repo/.worktrees" };
const external = { cwd: "/home/me/other", worktreesDir: "/mnt/fast/trees" };
const nested = {
  cwd: "/home/me/repo/vendor/lib",
  worktreesDir: "/home/me/repo/vendor/lib/.worktrees",
};

describe("findOwningProject", () => {
  test("matches a path under the project cwd", () => {
    expect(findOwningProject([repo, external], "/home/me/repo/src/a.ts")).toBe(repo);
    expect(findOwningProject([repo, external], "/home/me/repo")).toBe(repo);
  });

  test("matches a worktree under an external WT_DIR", () => {
    expect(findOwningProject([repo, external], "/mnt/fast/trees/topic")).toBe(external);
    expect(findOwningProject([repo, external], "/mnt/fast/trees")).toBe(external);
  });

  test("prefers the longest matching prefix", () => {
    expect(findOwningProject([repo, nested], "/home/me/repo/vendor/lib/x.ts")).toBe(nested);
    expect(findOwningProject([repo, nested], "/home/me/repo/vendor/x.ts")).toBe(repo);
  });

  test("does not match a sibling that merely shares a string prefix", () => {
    expect(findOwningProject([repo], "/home/me/repo-two/a.ts")).toBeUndefined();
    expect(findOwningProject([repo, external], "/elsewhere")).toBeUndefined();
  });
});

describe("externalFolderConflict", () => {
  const projects = [{ cwd: "/repos/app", worktreesDir: "/worktrees/app" }];

  test("allows folders unrelated to every project", () => {
    expect(externalFolderConflict(projects, "/notes", "/home/me")).toBeNull();
    expect(externalFolderConflict(projects, "/repos/app-notes", "/home/me")).toBeNull();
  });

  test("rejects folders inside or containing a project or its worktrees", () => {
    expect(externalFolderConflict(projects, "/repos/app/src", "/home/me")).toContain("belongs to");
    expect(externalFolderConflict(projects, "/worktrees/app/topic", "/home/me")).toContain(
      "belongs to",
    );
    expect(externalFolderConflict(projects, "/repos", "/home/me")).toContain("contains");
    expect(externalFolderConflict(projects, "/worktrees", "/home/me")).toContain("contains");
  });

  test("rejects the filesystem root and the home folder", () => {
    expect(externalFolderConflict(projects, "/", "/home/me")).toContain("too large");
    expect(externalFolderConflict(projects, "/home/me", "/home/me")).toContain("too large");
  });
});
