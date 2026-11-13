import type { Check, InitAction, InitActionId } from "@bizimind/wt/lib";

import type { RepoSetupPlan } from "@/api/project-model";

/**
 * The checks worth showing before an existing repository is added: every warning and failure,
 * and each other check with a fix to choose. Notes with nothing to do (the layout, the hooks
 * present) stay out of the way.
 */
export function visibleSetupChecks(plan: RepoSetupPlan): Check[] {
  const fixable = new Set(plan.actions.map((action) => action.check));
  return plan.checks.filter(
    (check) => check.status === "warn" || check.status === "fail" || fixable.has(check.id),
  );
}

const METADATA_ON: InitActionId = "worktree-metadata-on";

/**
 * The fixes that start checked: the ones `wt init --yes` would apply, plus turning worktree
 * metadata on, which nesting and titles in Loxel need, unless wt recommends another fix for it.
 */
export function defaultSetupActions(plan: RepoSetupPlan): InitActionId[] {
  const recommended = plan.actions.filter((action) => action.recommended);
  const metadataOn = plan.actions.find((action) => action.id === METADATA_ON);
  const metadataDecided = recommended.some((action) => action.check === metadataOn?.check);
  return [
    ...recommended.map((action) => action.id),
    ...(metadataOn && !metadataDecided ? [METADATA_ON] : []),
  ];
}

/** What a check says in the wizard. */
export type CheckCopy = Pick<Check, "title" | "summary" | "affects">;
/** What a fix says in the wizard; its commands are shown as wt gives them. */
export type ActionCopy = Pick<InitAction, "title" | "recommendation" | "tradeoffs">;

const METADATA_SUMMARY: Record<Check["status"], string> = {
  ok: "On.",
  info: "Off, so worktrees can't be nested or given titles.",
  warn: "Half turned off, after an interrupted change.",
  fail: "On, but set up so that linked worktrees fail.",
};

/** A check in Loxel's words: worktree metadata is worktree nesting here; the rest read as wt says. */
export function checkCopy(check: Check): CheckCopy {
  if (check.id !== "worktree-metadata") return check;
  return { title: "Worktree nesting", summary: METADATA_SUMMARY[check.status], affects: [] };
}

/** A fix in Loxel's words, for the check it resolves. */
export function actionCopy(action: InitAction, check: Check): ActionCopy {
  if (action.id === METADATA_ON) {
    return {
      title: check.status === "fail" ? "Repair worktree nesting" : "Turn on worktree nesting",
      recommendation: "Keeps each worktree's parent and title in its own git config.",
      tradeoffs: ["Some libgit2- and JGit-based tools may stop seeing the repository as bare."],
    };
  }
  if (action.id === "worktree-metadata-off") {
    return {
      title: "Turn off worktree nesting",
      recommendation: "Moves the settings back into the shared config; worktrees show flat.",
      tradeoffs: [],
    };
  }
  return action;
}

/**
 * Turn one fix on or off. The fixes for one check are alternatives (worktree metadata on or off),
 * so choosing one drops the others for that check.
 */
export function toggleSetupAction(
  plan: RepoSetupPlan,
  selected: InitActionId[],
  id: InitActionId,
): InitActionId[] {
  if (selected.includes(id)) return selected.filter((candidate) => candidate !== id);
  const check = plan.actions.find((action) => action.id === id)?.check;
  const alternatives = new Set(
    plan.actions.filter((action) => action.check === check).map((action) => action.id),
  );
  return [...selected.filter((candidate) => !alternatives.has(candidate)), id];
}
