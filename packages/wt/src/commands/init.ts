import { createResult, type OutputContext } from "@bizimind/cli-common";

import { detectRepoType } from "../git/index.ts";
import {
  cloneBareRepo,
  executeInit,
  INIT_ACTION_ORDER,
  planInit,
  type ActionOutcome,
  type Check,
  type InitAction,
  type InitActionId,
  type InitPlan,
} from "../lib/index.ts";
import { isTTY, selectSetupChoice } from "../prompt.ts";
import type { AbortedResult } from "./aborted.ts";
import { runCommand } from "./aborted.ts";
import { checkLabel, formatChecks } from "./doctor.ts";

export interface InitOptions {
  fetchRefspec?: boolean;
  setOriginHead?: boolean;
  prune?: boolean;
  worktreeMetadata?: string;
  mainWorktree?: boolean;
  yes?: boolean;
  json?: boolean;
}

/** The flag that decides each action, as shown to the user. */
export const ACTION_FLAGS: Record<InitActionId, string> = {
  "fetch-refspec": "--fetch-refspec",
  "origin-head": "--set-origin-head",
  "prune-worktrees": "--prune",
  "worktree-metadata-on": "--worktree-metadata on",
  "worktree-metadata-off": "--worktree-metadata off",
  "main-worktree": "--main-worktree",
};

/** A check that is not ok and has actions: one decision for the user. */
export interface Decision {
  check: Check;
  actions: InitAction[];
}

/** A decision nobody made, reported with the flags that would make it. */
export interface PendingDecision {
  check: Check;
  actions: Array<Pick<InitAction, "id" | "title" | "recommended" | "commands"> & { flag: string }>;
}

export interface InitCommandResult {
  root: string;
  bare: boolean;
  /** `wt init <url>` created the repository */
  cloned: boolean;
  outcomes: ActionOutcome[];
  pending: PendingDecision[];
  /** The checks after everything ran */
  checks: Check[];
}

/**
 * Check the repository's git setup and fix what the user decides to, or with
 * a URL, create a bare clone set up the way wt recommends first.
 */
export async function initCommand(
  url: string | undefined,
  dir: string | undefined,
  options: InitOptions,
): Promise<void> {
  await runCommand<InitCommandResult | AbortedResult>(options, async (ctx) => {
    const flags = parseFlags(options);
    let cloned: ActionOutcome[] | undefined;
    let repoPath = process.cwd();

    if (url) {
      const result = await cloneBareRepo({ url, dir, cwd: repoPath }, ctx);
      cloned = result.outcomes;
      repoPath = result.root;
    } else if ((await detectRepoType(repoPath)) === "empty") {
      throw new Error(
        "Not inside a git repository.\n\nTo create a bare clone set up for wt: wt init <url> [dir]",
      );
    }

    const plan = await planInit(repoPath);
    const { apply, undecided } = resolveDecisions(plan, flags, options.yes ?? false);
    const pending: Decision[] = [];
    if (isTTY()) {
      for (const decision of undecided) {
        const choice = await askDecision(decision, plan.root, ctx);
        if (choice) apply.push(choice);
      }
    } else {
      pending.push(...undecided);
    }

    const result = await executeInit(repoPath, { apply }, ctx);
    const outcomes = [...(cloned ?? []), ...result.outcomes];
    const data: InitCommandResult = {
      root: result.root,
      bare: result.bare,
      cloned: cloned !== undefined,
      outcomes,
      pending: pending.map(toPending),
      checks: result.checks,
    };
    const failed = outcomes.some((outcome) => outcome.status === "failed");
    return createResult<InitCommandResult>(data, formatInitResult, failed ? 1 : 0);
  });
}

/** Explicit per-action choices from the flags: true applies, false skips, absent is undecided. */
export type FlagDecisions = Partial<Record<InitActionId, boolean>>;

export function parseFlags(options: InitOptions): FlagDecisions {
  const metadata = options.worktreeMetadata;
  if (metadata !== undefined && metadata !== "on" && metadata !== "off") {
    throw new Error(`--worktree-metadata takes 'on' or 'off', not '${metadata}'.`);
  }
  const flags: FlagDecisions = {
    "fetch-refspec": options.fetchRefspec,
    "origin-head": options.setOriginHead,
    "prune-worktrees": options.prune,
    "main-worktree": options.mainWorktree,
  };
  if (metadata) {
    flags["worktree-metadata-on"] = metadata === "on";
    flags["worktree-metadata-off"] = metadata === "off";
  }
  return flags;
}

/**
 * Split the plan into what to apply and what is left to ask.
 *
 * A flag decides its action whether or not the check needs it (turning
 * worktree metadata off, say, is only ever offered this way). Every other
 * non-ok check with actions is a decision: `--yes` takes its recommended
 * action, or skips it when none is recommended; otherwise it stays undecided.
 */
export function resolveDecisions(
  plan: InitPlan,
  flags: FlagDecisions,
  yes: boolean,
): { apply: InitActionId[]; undecided: Decision[] } {
  const apply = INIT_ACTION_ORDER.filter((id) => flags[id] === true);
  const undecided: Decision[] = [];

  for (const decision of decisions(plan)) {
    if (decision.actions.some((action) => flags[action.id] !== undefined)) continue;
    if (!yes) {
      undecided.push(decision);
      continue;
    }
    const recommended = decision.actions.find((action) => action.recommended);
    if (recommended) apply.push(recommended.id);
  }
  return { apply, undecided };
}

function decisions(plan: InitPlan): Decision[] {
  return plan.checks
    .filter((check) => check.status !== "ok")
    .map((check) => ({
      check,
      actions: plan.actions.filter((action) => action.check === check.id),
    }))
    .filter((decision) => decision.actions.length > 0);
}

/** Walk the user through one decision. Returns the action to apply, or null to skip. */
async function askDecision(
  { check, actions }: Decision,
  root: string,
  ctx: OutputContext,
): Promise<InitActionId | null> {
  ctx.log("");
  ctx.log(`${checkLabel(check)}: ${check.summary}`);
  for (const line of check.affects) ctx.log(`  Without it: ${line}`);
  for (const action of actions) {
    ctx.log("");
    ctx.log(`  ${action.recommended ? "Recommended" : "Optional"}: ${action.title}`);
    ctx.log(`    ${action.recommendation}`);
    ctx.log(`    Runs in ${root}:`);
    for (const command of action.commands) ctx.log(`      $ ${command}`);
  }

  for (;;) {
    const choice = await selectSetupChoice(`${check.title}:`, actions);
    if (choice === "skip") return null;
    if (choice !== "explain") return choice;
    for (const action of actions) {
      ctx.log(`  ${action.title}`);
      for (const tradeoff of action.tradeoffs) ctx.log(`    - ${tradeoff}`);
    }
  }
}

function toPending({ check, actions }: Decision): PendingDecision {
  return {
    check,
    actions: actions.map(({ id, title, recommended, commands }) => ({
      id,
      title,
      recommended,
      commands,
      flag: ACTION_FLAGS[id],
    })),
  };
}

const OUTCOME_SYMBOL: Record<ActionOutcome["status"], string> = {
  applied: "✓",
  "not-needed": "-",
  failed: "✗",
};

function formatInitResult(result: InitCommandResult): string {
  const sections: string[] = [];
  if (result.cloned) sections.push(`Cloned into ${result.root}`);

  if (result.outcomes.length > 0) {
    const lines = result.outcomes.map((outcome) => {
      const detail =
        outcome.status === "failed"
          ? `failed: ${outcome.error}`
          : outcome.status === "applied"
            ? "applied"
            : "already done";
      return `  ${OUTCOME_SYMBOL[outcome.status]} ${outcome.id}: ${detail}`;
    });
    sections.push(["Actions:", ...lines].join("\n"));
  } else if (result.pending.length === 0) {
    sections.push("Nothing changed.");
  }

  if (result.pending.length > 0) {
    const lines = result.pending.flatMap(({ check, actions }) => [
      `  ${checkLabel(check)}: ${check.summary}`,
      ...actions.map(
        (action) =>
          `      ${action.flag}  ${action.title}${action.recommended ? " (recommended)" : ""}`,
      ),
    ]);
    sections.push(
      [
        "Pending decisions (nothing was changed for these; pass a flag, or --yes for every recommended one):",
        ...lines,
      ].join("\n"),
    );
  }

  // Pending checks were just listed; show the rest that are not ok.
  const pendingIds = new Set(result.pending.map(({ check }) => check.id));
  const remaining = result.checks.filter(
    (check) => check.status !== "ok" && !pendingIds.has(check.id),
  );
  const header = `Repository: ${result.root}${result.bare ? " (bare)" : ""}`;
  sections.push(
    remaining.length > 0
      ? `${header}\n${formatChecks(remaining)}`
      : `${header}\n${pendingIds.size > 0 ? "All other checks pass." : "All checks pass."}`,
  );
  return `\n${sections.join("\n\n")}`;
}
