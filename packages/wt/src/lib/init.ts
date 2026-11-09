import { resolve } from "node:path";

import { git, listWorktrees, resolveRepoRoot } from "../git/index.ts";
import type { HookContext } from "../hooks/run.ts";
import { silentProgress, type ProgressHandler } from "../progress.ts";
import { executeAdd } from "./add.ts";
import {
  describeStep,
  evaluate,
  INIT_ACTION_ORDER,
  inspectRepo,
  type Check,
  type InitAction,
  type InitActionId,
  type InitStep,
} from "./checks.ts";
import { ensureWorktreeId } from "./meta.ts";
import { shellArg } from "./shell-quote.ts";

/** The checks for one repository, as `wt doctor` reports them. */
export interface Diagnosis {
  /** The main worktree's top level, or the git dir of a bare repo */
  root: string;
  bare: boolean;
  /** No check failed */
  ok: boolean;
  checks: Check[];
}

/** The checks plus every action `executeInit` could apply right now. */
export interface InitPlan {
  root: string;
  bare: boolean;
  checks: Check[];
  actions: InitAction[];
}

export interface InitDecisions {
  /**
   * Actions to apply. Only these run: nothing in a repository's config changes
   * unless it is listed here. Order does not matter; see `INIT_ACTION_ORDER`.
   */
  apply: InitActionId[];
  /** Base environment for init.wt.sh when an action adds a worktree (default: process.env) */
  hookEnv?: HookContext["baseEnv"];
}

export interface ActionOutcome {
  id: InitActionId;
  /** `not-needed`: the repository was already in the state the action produces */
  status: "applied" | "not-needed" | "failed";
  /** The commands that ran (on failure, up to and including the one that failed) */
  commands: string[];
  /** Why it failed */
  error?: string;
}

export interface InitResult {
  root: string;
  bare: boolean;
  outcomes: ActionOutcome[];
  /** The checks after the actions ran */
  checks: Check[];
}

export interface CloneParams {
  /** Anything `git clone` accepts */
  url: string;
  /** Where to clone to (default: the repository name from the URL), relative to `cwd` */
  dir?: string;
  cwd: string;
  /** Base environment for init.wt.sh in the first worktree (default: process.env) */
  hookEnv?: HookContext["baseEnv"];
  /** The setup actions to apply after cloning (default: `CLONE_ACTIONS`) */
  apply?: InitActionId[];
}

/** What `cloneBareRepo` sets up by default; `fetch-refspec` also records `origin/HEAD`. */
export const CLONE_ACTIONS: readonly InitActionId[] = ["fetch-refspec", "main-worktree"];

/**
 * Run every check against the repository containing `repoPath`. Read-only.
 *
 * @param repoPath - Any path inside the repository (bare or non-bare)
 */
export async function diagnose(repoPath: string): Promise<Diagnosis> {
  const state = await inspectRepo(repoPath);
  const { checks } = evaluate(state);
  return {
    root: state.root,
    bare: state.bare,
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

/**
 * The checks, and the actions that would resolve them, each with a
 * recommendation, its tradeoffs and the exact commands. Read-only: pass the
 * chosen action ids to `executeInit`.
 *
 * @param repoPath - Any path inside the repository (bare or non-bare)
 */
export async function planInit(repoPath: string): Promise<InitPlan> {
  const state = await inspectRepo(repoPath);
  const { checks, actions } = evaluate(state);
  return {
    root: state.root,
    bare: state.bare,
    checks,
    actions: actions.map(({ steps: _steps, ...action }) => action),
  };
}

/**
 * Apply the decided actions, in `INIT_ACTION_ORDER`, logging each command
 * before it runs. Each action is re-planned against the repository as it is
 * when its turn comes, so an action that is no longer needed (or already
 * applied by an earlier run) does nothing. A failed action is reported and the
 * rest still run.
 *
 * @param repoPath - Any path inside the repository (bare or non-bare)
 */
export async function executeInit(
  repoPath: string,
  decisions: InitDecisions,
  progress: ProgressHandler = silentProgress,
): Promise<InitResult> {
  assertValidDecisions(decisions.apply);
  const root = await resolveRepoRoot(repoPath);
  const outcomes: ActionOutcome[] = [];

  for (const id of INIT_ACTION_ORDER) {
    if (!decisions.apply.includes(id)) continue;
    const action = evaluate(await inspectRepo(root)).actions.find((planned) => planned.id === id);
    if (!action || action.steps.length === 0) {
      progress.log(`${id}: nothing to do`);
      outcomes.push({ id, status: "not-needed", commands: [] });
      continue;
    }

    progress.log(action.title);
    const commands: string[] = [];
    try {
      for (const step of action.steps) {
        const command = describeStep(step);
        commands.push(command);
        progress.log(`  $ ${command}`);
        await runStep(step, root, decisions.hookEnv, progress);
      }
      outcomes.push({ id, status: "applied", commands });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      progress.warn(`${id} failed: ${message}`);
      outcomes.push({ id, status: "failed", commands, error: message });
    }
  }

  const state = await inspectRepo(root);
  return { root, bare: state.bare, outcomes, checks: evaluate(state).checks };
}

/**
 * Create a bare clone set up the way wt recommends: the fetch refspec a plain
 * `git clone --bare` leaves out, `origin/*` fetched, `origin/HEAD` recorded,
 * and the default branch checked out as the first worktree (`CLONE_ACTIONS`,
 * or the actions in `apply`).
 */
export async function cloneBareRepo(
  params: CloneParams,
  progress: ProgressHandler = silentProgress,
): Promise<InitResult> {
  const target = resolve(params.cwd, params.dir ?? defaultCloneDir(params.url));
  progress.log(`$ git clone --bare -- ${shellArg(params.url)} ${shellArg(target)}`);
  await git(["clone", "--bare", "--", params.url, target], params.cwd);

  return executeInit(
    target,
    { apply: [...(params.apply ?? CLONE_ACTIONS)], hookEnv: params.hookEnv },
    progress,
  );
}

/** The directory `git clone` would pick, minus the `.git` suffix: `org/proj.git` → `proj`. */
export function defaultCloneDir(url: string): string {
  // Split rather than trim with a regex: a `[/\\]+$` on untrusted input backtracks polynomially.
  const segments = url.split(/[/:\\]/).filter(Boolean);
  let name = segments.pop() ?? "";
  if (name === ".git") name = segments.pop() ?? "";
  if (name.endsWith(".git")) name = name.slice(0, -".git".length);
  if (!name) throw new Error(`Cannot derive a directory name from '${url}'; pass one.`);
  return name;
}

function assertValidDecisions(apply: InitActionId[]): void {
  for (const id of apply) {
    if (!INIT_ACTION_ORDER.includes(id)) throw new Error(`Unknown init action '${id}'.`);
  }
  if (apply.includes("worktree-metadata-on") && apply.includes("worktree-metadata-off")) {
    throw new Error("Cannot turn worktree metadata both on and off.");
  }
}

async function runStep(
  step: InitStep,
  root: string,
  hookEnv: HookContext["baseEnv"],
  progress: ProgressHandler,
): Promise<void> {
  if (step.kind === "add-worktree") {
    await executeAdd({ name: step.name, repoPath: root, branch: step.branch, hookEnv }, progress);
    return;
  }
  if (step.kind === "assign-worktree-ids") {
    await assignWorktreeIds(step.paths, root, progress);
    return;
  }
  if (step.onlyWithOriginRefs && !(await hasOriginRefs(root))) {
    progress.log("    skipped: origin has no branches");
    return;
  }
  const output = await git(step.args, root);
  for (const line of output.split("\n")) if (line.trim()) progress.log(`    ${line}`);
}

/**
 * Give each worktree an id. One that is gone by now (a tool removed it since the plan) is
 * skipped, and one failure does not keep the others from getting theirs: the failures are
 * thrown together at the end.
 */
async function assignWorktreeIds(
  paths: string[],
  root: string,
  progress: ProgressHandler,
): Promise<void> {
  const live = new Set(
    (await listWorktrees(root)).filter((wt) => !wt.bare && !wt.prunable).map((wt) => wt.path),
  );
  const failures: string[] = [];
  for (const path of paths) {
    if (!live.has(path)) {
      progress.log(`    ${path}: skipped, the worktree is gone`);
      continue;
    }
    try {
      progress.log(`    ${path}: ${await ensureWorktreeId({ repoPath: root, path })}`);
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not give every worktree a wt-id:\n  ${failures.join("\n  ")}`);
  }
}

async function hasOriginRefs(root: string): Promise<boolean> {
  const refs = await git(
    ["for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes/origin/"],
    root,
  );
  return refs !== "";
}
