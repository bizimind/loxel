import { describe, expect, test } from "bun:test";

import type { Check, InitAction } from "@bizimind/wt/lib";

import type { RepoSetupPlan } from "@/api/project-model";

import { recommendedSetupActions, toggleSetupAction, visibleSetupChecks } from "./repo-setup";

function check(id: Check["id"], status: Check["status"]): Check {
  return { id, status, title: id, summary: "", affects: [], fixable: false };
}

function action(id: InitAction["id"], checkId: Check["id"], recommended: boolean): InitAction {
  return {
    id,
    check: checkId,
    title: id,
    recommended,
    recommendation: "",
    tradeoffs: [],
    commands: [],
  };
}

const plan: RepoSetupPlan = {
  checks: [
    check("layout", "info"),
    check("fetch-refspec", "warn"),
    check("worktree-metadata", "fail"),
    check("main-worktree", "info"),
    check("locked-worktrees", "warn"),
  ],
  actions: [
    action("fetch-refspec", "fetch-refspec", true),
    action("worktree-metadata-on", "worktree-metadata", true),
    action("worktree-metadata-off", "worktree-metadata", false),
    action("main-worktree", "main-worktree", true),
  ],
};

describe("repository setup choices", () => {
  test("shows warnings, failures and fixable notes, not notes with nothing to do", () => {
    expect(visibleSetupChecks(plan).map((c) => c.id)).toEqual([
      "fetch-refspec",
      "worktree-metadata",
      "main-worktree",
      "locked-worktrees",
    ]);
  });

  test("starts with the recommended fixes, as wt init --yes", () => {
    expect(recommendedSetupActions(plan)).toEqual([
      "fetch-refspec",
      "worktree-metadata-on",
      "main-worktree",
    ]);
  });

  test("choosing one fix for a check drops its alternatives, and unchecking removes it", () => {
    const start = recommendedSetupActions(plan);
    const off = toggleSetupAction(plan, start, "worktree-metadata-off");
    expect(off).toEqual(["fetch-refspec", "main-worktree", "worktree-metadata-off"]);
    expect(toggleSetupAction(plan, off, "fetch-refspec")).toEqual([
      "main-worktree",
      "worktree-metadata-off",
    ]);
  });
});
