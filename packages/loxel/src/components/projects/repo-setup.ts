import type { Check, InitActionId } from "@bizimind/wt/lib";

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

/** The fixes `wt init --yes` would apply: the recommended ones. */
export function recommendedSetupActions(plan: RepoSetupPlan): InitActionId[] {
  return plan.actions.filter((action) => action.recommended).map((action) => action.id);
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
