import { describe, expect, test } from "bun:test";

import { worktreeNameFromTitle } from "./worktree-labels";

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
