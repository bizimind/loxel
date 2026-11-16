import { describe, expect, test } from "bun:test";

import { worktreeBaseHint, worktreeNameFromTitle } from "./worktree-labels";

describe("worktreeNameFromTitle", () => {
  test("lowercases and joins words with single dashes", () => {
    expect(worktreeNameFromTitle("  Fix the   LSP crash ")).toBe("fix-the-lsp-crash");
  });

  test("drops characters a branch name should not have", () => {
    expect(worktreeNameFromTitle("Fix: LSP crash! (again)")).toBe("fix-lsp-crash-again");
  });

  test("keeps slashes, dots and underscores, but not at the ends", () => {
    expect(worktreeNameFromTitle("feat/new_api v1.2")).toBe("feat/new_api-v1.2");
    expect(worktreeNameFromTitle("-/hello./")).toBe("hello");
  });
});

describe("worktreeBaseHint", () => {
  const commit = "c2405e7f00d1b2c3";
  const plan = { remoteDefault: "origin/main", parent: { commit, behind: 109 } };

  test("names the remote default, or HEAD when there is none", () => {
    expect(worktreeBaseHint(plan, null)).toBe("Starts from origin/main");
    expect(worktreeBaseHint({ remoteDefault: null, parent: null }, null)).toBe("Starts from HEAD");
  });

  test("names the parent's short commit and how far behind it is", () => {
    const stackOn = { label: "pocs" };
    expect(worktreeBaseHint(plan, stackOn)).toBe(
      "Starts from pocs at c2405e7, 109 commits behind origin/main",
    );
    expect(worktreeBaseHint({ ...plan, parent: { commit, behind: 1 } }, stackOn)).toBe(
      "Starts from pocs at c2405e7, 1 commit behind origin/main",
    );
    expect(worktreeBaseHint({ ...plan, parent: { commit, behind: 0 } }, stackOn)).toBe(
      "Starts from pocs at c2405e7, up to date with origin/main",
    );
    expect(
      worktreeBaseHint({ remoteDefault: null, parent: { commit, behind: null } }, stackOn),
    ).toBe("Starts from pocs at c2405e7");
  });
});
