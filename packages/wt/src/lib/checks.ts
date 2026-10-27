/**
 * Repository setup checks shared by `wt doctor` (report only) and `wt init`
 * (report, then fix what the user decides to).
 *
 * `inspectRepo` reads everything once; `evaluate` turns that snapshot into
 * checks and the actions that would resolve them, without touching git, so
 * the same state always yields the same report. Actions are plain data (the
 * commands they would run are strings) so a UI can show them before anything
 * changes.
 */
import { join, relative } from "node:path";

import { compareVersions } from "@bizimind/cli-common";

import {
  branchExists,
  canonicalWorktreesDir,
  disableWorktreeConfigCommands,
  enableWorktreeConfigCommands,
  getWorktreeName,
  isWorktreeConfigBroken,
  listWorktrees,
  pathExists,
  readWorktreeConfigState,
  resolveRemoteDefault,
  resolveRepoRoot,
  runGit,
  type Worktree,
  type WorktreeConfigState,
} from "../git/index.ts";
import { HOOK_CLEAN, HOOK_INIT, HOOK_RENAME } from "../hooks/run.ts";
import { shellArg } from "./shell-quote.ts";

/** `ok` needs nothing; `info` is a choice worth knowing about; `warn` costs a feature; `fail` breaks wt. */
export type CheckStatus = "ok" | "info" | "warn" | "fail";

export type CheckId =
  | "git-version"
  | "layout"
  | "wt-dir"
  | "legacy-config"
  | "fetch-refspec"
  | "origin-head"
  | "main-worktree"
  | "worktree-metadata"
  | "stale-worktrees"
  | "locked-worktrees"
  | "hooks";

export interface Check {
  id: CheckId;
  status: CheckStatus;
  /** Short label, e.g. "Fetch refspec" */
  title: string;
  /** What was found */
  summary: string;
  /** What does not work until this is resolved; empty when nothing is affected */
  affects: string[];
  /** `wt init` has an action that resolves it */
  fixable: boolean;
}

export type InitActionId =
  | "fetch-refspec"
  | "origin-head"
  | "prune-worktrees"
  | "worktree-metadata-on"
  | "worktree-metadata-off"
  | "main-worktree";

/** The order `executeInit` applies actions in: each may rely on the ones before it. */
export const INIT_ACTION_ORDER: readonly InitActionId[] = [
  "fetch-refspec",
  "origin-head",
  "prune-worktrees",
  "worktree-metadata-on",
  "worktree-metadata-off",
  "main-worktree",
];

export interface InitAction {
  id: InitActionId;
  /** The check this action resolves */
  check: CheckId;
  title: string;
  /** Whether wt recommends applying it; `--yes` applies exactly the recommended ones */
  recommended: boolean;
  /** Why it is (or is not) recommended */
  recommendation: string;
  /** What else applying it does or costs */
  tradeoffs: string[];
  /** The exact commands it runs, in order, from the repository root */
  commands: string[];
}

/** One thing an action runs. */
export type InitStep =
  | { kind: "git"; args: string[] }
  | { kind: "add-worktree"; name: string; branch: string };

/** An action together with the steps behind its `commands`. */
export interface PlannedAction extends InitAction {
  steps: InitStep[];
}

/** Everything the checks look at, read once. */
export interface RepoState {
  /** The main worktree's top level, or the git dir of a bare repo */
  root: string;
  bare: boolean;
  /** Where new worktrees go */
  worktreesDir: string;
  /** `WT_DIR`, when set */
  wtDir: string | undefined;
  /** e.g. "2.50.1", or null when unreadable */
  gitVersion: string | null;
  worktrees: Worktree[];
  originUrl: string | null;
  fetchRefspecs: string[];
  /** Whether any `refs/remotes/origin/*` ref exists */
  hasOriginRefs: boolean;
  /** Where `origin/HEAD` points (`origin/main`), whether or not that ref exists */
  originHead: string | null;
  /** The remote default `wt add` starts from (see `resolveRemoteDefault`) */
  remoteDefault: string | null;
  /** The local branch a bare repo's first worktree checks out, when there is one */
  defaultBranch: string | null;
  worktreeConfig: WorktreeConfigState;
  /** Hook scripts present at the root */
  hooks: string[];
  /** A `wt.yaml` from the config-based CLI is at the root */
  legacyConfig: boolean;
}

/** Oldest git wt supports: `git worktree move` and `rev-parse --path-format`. */
export const MIN_GIT_VERSION = "2.31";
const FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
const HOOKS = [HOOK_INIT, HOOK_CLEAN, HOOK_RENAME];

/** Read the repository state the checks need. Read-only. */
export async function inspectRepo(repoPath: string): Promise<RepoState> {
  const root = await resolveRepoRoot(repoPath);
  const bare = (await gitOutput(["rev-parse", "--is-bare-repository"], root)) === "true";
  const [worktreesDir, worktrees, worktreeConfig, gitVersion] = await Promise.all([
    canonicalWorktreesDir(root),
    listWorktrees(root),
    readWorktreeConfigState(root),
    readGitVersion(root),
  ]);

  const originUrl = await gitOutput(["config", "--get", "remote.origin.url"], root);
  const refspecs = await gitOutput(["config", "--get-all", "remote.origin.fetch"], root);
  const originRefs = await gitOutput(
    ["for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes/origin/"],
    root,
  );
  const originHead = await gitOutput(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  const remoteDefault = await resolveRemoteDefault(root);

  const hooks: string[] = [];
  for (const hook of HOOKS) {
    if (await pathExists(join(root, hook))) hooks.push(hook);
  }

  return {
    root,
    bare,
    worktreesDir,
    wtDir: process.env.WT_DIR || undefined,
    gitVersion,
    worktrees,
    originUrl,
    fetchRefspecs: refspecs ? refspecs.split("\n") : [],
    hasOriginRefs: Boolean(originRefs),
    originHead,
    remoteDefault,
    defaultBranch: bare ? await bareDefaultBranch(root, remoteDefault) : null,
    worktreeConfig,
    hooks,
    legacyConfig: await pathExists(join(root, "wt.yaml")),
  };
}

/**
 * Every check that applies to the repository, in display order, and the
 * actions available for it. An action is offered only while it would change
 * something, except turning per-worktree config off, which stays available
 * whenever it is on.
 */
export function evaluate(state: RepoState): { checks: Check[]; actions: PlannedAction[] } {
  const checks: Check[] = [];
  const actions: PlannedAction[] = [];
  const add = (check: Omit<Check, "fixable">, ...offered: PlannedAction[]) => {
    checks.push({ ...check, fixable: offered.length > 0 });
    actions.push(...offered);
  };

  add(gitVersionCheck(state.gitVersion));
  add(layoutCheck(state));
  if (state.wtDir) {
    add({
      id: "wt-dir",
      status: "info",
      title: "Worktrees directory",
      summary: `WT_DIR is set: new worktrees go in ${state.worktreesDir} instead of ${join(state.root, ".worktrees")}`,
      affects: [],
    });
  }
  if (state.legacyConfig) {
    add({
      id: "legacy-config",
      status: "warn",
      title: "Legacy wt.yaml",
      summary: "wt.yaml is from the config-based wt and is ignored",
      affects: [
        "Its hooks, file copies, worktrees_dir and ports do nothing; move them into init.wt.sh, clean.wt.sh and WT_DIR, then delete it",
      ],
    });
  }
  addRemoteChecks(state, add);
  addMainWorktreeCheck(state, add);
  addWorktreeMetadataCheck(state.root, state.worktreeConfig, add);
  addWorktreeListChecks(state, add);
  add({
    id: "hooks",
    status: "ok",
    title: "Hooks",
    summary:
      state.hooks.length > 0 ? state.hooks.join(", ") : "No hook scripts (they are optional)",
    affects: [],
  });

  return { checks, actions };
}

/** Render a step as the command a user would type in the repository root. */
export function describeStep(step: InitStep): string {
  if (step.kind === "add-worktree") {
    return `wt add ${shellArg(step.name)} -b ${shellArg(step.branch)}`;
  }
  return ["git", ...step.args].map(shellArg).join(" ");
}

type AddCheck = (check: Omit<Check, "fixable">, ...offered: PlannedAction[]) => void;

function plannedAction(action: Omit<InitAction, "commands">, steps: InitStep[]): PlannedAction {
  return { ...action, commands: steps.map(describeStep), steps };
}

function gitStep(...args: string[]): InitStep {
  return { kind: "git", args };
}

function gitVersionCheck(version: string | null): Omit<Check, "fixable"> {
  const base = { id: "git-version", title: "Git version" } as const;
  if (!version) {
    return { ...base, status: "warn", summary: "Could not read the git version", affects: [] };
  }
  if (compareVersions(version, MIN_GIT_VERSION) < 0) {
    return {
      ...base,
      status: "fail",
      summary: `Git ${version} is older than ${MIN_GIT_VERSION}`,
      affects: [
        `wt needs git ${MIN_GIT_VERSION}+ (git worktree move, rev-parse --path-format, per-worktree config); upgrade git`,
      ],
    };
  }
  return { ...base, status: "ok", summary: `Git ${version}`, affects: [] };
}

function layoutCheck(state: RepoState): Omit<Check, "fixable"> {
  const base = { id: "layout", title: "Layout" } as const;
  if (state.bare) {
    return {
      ...base,
      status: "ok",
      summary: `Bare repository; every checkout is a worktree in ${state.worktreesDir}`,
      affects: [],
    };
  }
  return {
    ...base,
    status: "info",
    summary: `Regular repository; the root is the main checkout and worktrees go in ${state.worktreesDir}. The bare layout (every checkout under .worktrees/, the root left for git, hooks and local-only files) is recommended`,
    affects: [],
  };
}

function addRemoteChecks(state: RepoState, add: AddCheck): void {
  const base = { id: "fetch-refspec", title: "Fetch refspec" } as const;
  if (!state.originUrl) {
    add({
      ...base,
      status: "info",
      summary: "No 'origin' remote",
      affects: ["wt add starts new branches from HEAD rather than from origin's default branch"],
    });
    return;
  }
  if (state.fetchRefspecs.length === 0) {
    // Without a refspec there is nothing for origin/HEAD to point at, so this
    // action records it as well and origin-head is not checked separately.
    add(
      {
        ...base,
        status: "warn",
        summary:
          "origin has no fetch refspec (usual after git clone --bare), so git fetch creates no origin/* branches",
        affects: [
          "wt add starts new branches from HEAD rather than from origin's default branch",
          "wt remove -d only counts a branch as merged when it is merged into HEAD",
        ],
      },
      plannedAction(
        {
          id: "fetch-refspec",
          check: "fetch-refspec",
          title: "Add origin's fetch refspec, fetch, and record origin/HEAD",
          recommended: true,
          recommendation: "Gives wt the origin/* branches new worktrees start from",
          tradeoffs: [
            "Contacts origin (git fetch, git remote set-head), so it needs network access and credentials",
            "Fetches every branch on origin into origin/*",
          ],
        },
        [
          gitStep("config", "remote.origin.fetch", FETCH_REFSPEC),
          gitStep("fetch", "origin"),
          gitStep("remote", "set-head", "origin", "--auto"),
        ],
      ),
    );
    return;
  }
  add({
    ...base,
    status: "ok",
    summary: `origin fetches ${state.fetchRefspecs.join(", ")}`,
    affects: [],
  });
  add(...originHeadCheck(state));
}

function originHeadCheck(state: RepoState): Parameters<AddCheck> {
  const base = { id: "origin-head", title: "origin/HEAD" } as const;
  if (state.originHead && state.remoteDefault === state.originHead) {
    return [{ ...base, status: "ok", summary: `origin/HEAD is ${state.originHead}`, affects: [] }];
  }

  const steps = [
    ...(state.hasOriginRefs ? [] : [gitStep("fetch", "origin")]),
    gitStep("remote", "set-head", "origin", "--auto"),
  ];
  const action = plannedAction(
    {
      id: "origin-head",
      check: "origin-head",
      title: "Ask origin for its default branch and record it as origin/HEAD",
      recommended: true,
      recommendation: "wt add then starts from origin's actual default branch",
      tradeoffs: ["Contacts origin, so it needs network access and credentials"],
    },
    steps,
  );

  const unset = state.originHead
    ? `origin/HEAD points to ${state.originHead}, which no longer exists`
    : "origin/HEAD is not set";
  if (state.remoteDefault) {
    return [
      {
        ...base,
        status: "info",
        summary: `${unset}; wt add uses ${state.remoteDefault}, found by name`,
        affects: ["If origin's default branch has another name, wt add starts from the wrong one"],
      },
      action,
    ];
  }
  return [
    {
      ...base,
      status: "warn",
      summary: `${unset}, and there is no origin/main or origin/master`,
      affects: ["wt add starts new branches from HEAD rather than from origin's default branch"],
    },
    action,
  ];
}

function addMainWorktreeCheck(state: RepoState, add: AddCheck): void {
  const branch = state.defaultBranch;
  if (!state.bare || !branch) return;

  const base = { id: "main-worktree", title: "Default branch worktree" } as const;
  const existing = state.worktrees.find((wt) => !wt.bare && !wt.prunable && wt.branch === branch);
  if (existing) {
    add({
      ...base,
      status: "ok",
      summary: `${branch} is checked out at ${existing.path}`,
      affects: [],
    });
    return;
  }

  const path = join(state.worktreesDir, branch);
  add(
    {
      ...base,
      status: "info",
      summary: `No worktree has the default branch '${branch}' checked out`,
      affects: [
        `Nowhere to pull, build or run ${branch}; hooks that copy from $WT_ROOT/.worktrees/${branch} find nothing`,
      ],
    },
    plannedAction(
      {
        id: "main-worktree",
        check: "main-worktree",
        title: `Check out '${branch}' as worktree '${getWorktreeName(path, state.worktreesDir)}'`,
        recommended: true,
        recommendation: "The bare layout keeps the default branch in a worktree of its own",
        tradeoffs: [`Creates ${path} and runs ${HOOK_INIT} in it, if present`],
      },
      [{ kind: "add-worktree", name: getWorktreeName(path, state.worktreesDir), branch }],
    ),
  );
}

function addWorktreeMetadataCheck(root: string, config: WorktreeConfigState, add: AddCheck): void {
  const base = { id: "worktree-metadata", title: "Worktree metadata" } as const;
  // Steps run in the root, so show the config files relative to it: `config.worktree` in a bare
  // repo, `.git/config.worktree` in a regular one.
  const toSteps = (commands: string[][]) =>
    commands.map((args) =>
      gitStep(...args.map((arg, i) => (args[i - 1] === "--file" ? relative(root, arg) : arg))),
    );
  const moved = Object.keys(config.shared).join(" and ");
  const enable = (recommended: boolean, recommendation: string) =>
    plannedAction(
      {
        id: "worktree-metadata-on",
        check: "worktree-metadata",
        title: config.enabled
          ? `Repair per-worktree config: move ${moved} into config.worktree`
          : "Turn on per-worktree config (extensions.worktreeConfig)",
        recommended,
        recommendation,
        tradeoffs: [
          ...(moved
            ? [
                `Moves ${moved} from the shared config into ${relative(root, config.mainFile)}, where git requires it once per-worktree config is on`,
                `Tools that don't support extensions.worktreeConfig (some libgit2- and JGit-based apps) read only the shared config and may no longer see ${moved}`,
              ]
            : []),
          "Undo with: wt init --worktree-metadata off",
        ],
      },
      toSteps(enableWorktreeConfigCommands(config)),
    );
  const disable = (recommendation: string) => {
    const keys = config.worktreeKeys.flatMap((entry) => entry.keys);
    return plannedAction(
      {
        id: "worktree-metadata-off",
        check: "worktree-metadata",
        title: "Turn off per-worktree config (extensions.worktreeConfig)",
        recommended: false,
        recommendation,
        tradeoffs: [
          "Features that store metadata per worktree, such as nesting worktrees in Loxel, stop working",
          ...(keys.length > 0
            ? [
                `Settings written with git config --worktree stop applying until it is turned back on: ${[...new Set(keys)].join(", ")}`,
              ]
            : []),
        ],
      },
      toSteps(disableWorktreeConfigCommands(config)),
    );
  };

  if (!config.enabled) {
    add(
      {
        ...base,
        status: "info",
        summary: "Per-worktree config (extensions.worktreeConfig) is off",
        affects: [
          "Worktree nesting and other per-worktree metadata (git config --worktree) are disabled",
        ],
      },
      enable(
        false,
        "Only needed for features that store metadata per worktree, such as nesting worktrees in Loxel. wt never turns it on by itself",
      ),
    );
    return;
  }
  if (isWorktreeConfigBroken(config)) {
    add(
      {
        ...base,
        status: "fail",
        summary: `Per-worktree config is on, but ${moved} is still in the shared config`,
        affects: [
          "Linked worktrees are broken: every one inherits the main worktree's settings, and in a bare repo git fails in them with 'this operation must be run in a work tree'",
        ],
      },
      enable(true, "Keeps per-worktree config on and makes linked worktrees work again"),
      disable("Also fixes the linked worktrees, by turning per-worktree config off instead"),
    );
    return;
  }
  add(
    {
      ...base,
      status: "ok",
      summary: "Per-worktree config (extensions.worktreeConfig) is on",
      affects: [],
    },
    disable("Only if a tool you use does not support extensions.worktreeConfig"),
  );
}

function addWorktreeListChecks(state: RepoState, add: AddCheck): void {
  const stale = state.worktrees.filter((wt) => !wt.bare && wt.prunable);
  if (stale.length === 0) {
    add({
      id: "stale-worktrees",
      status: "ok",
      title: "Stale worktrees",
      summary: "None",
      affects: [],
    });
  } else {
    add(
      {
        id: "stale-worktrees",
        status: "warn",
        title: "Stale worktrees",
        summary: `Registered, but their directory is gone: ${stale.map((wt) => wt.path).join(", ")}`,
        affects: [
          "Their branches still count as checked out, so wt add -b refuses them",
          "Their paths cannot be reused for a new worktree",
        ],
      },
      plannedAction(
        {
          id: "prune-worktrees",
          check: "stale-worktrees",
          title: "Prune stale worktrees (git worktree prune)",
          recommended: true,
          recommendation: "Their checkouts are already gone; only git's records of them remain",
          tradeoffs: [
            "Branches are kept",
            "A worktree on a drive that is not mounted right now also counts as gone; lock it (git worktree lock) to keep it registered",
          ],
        },
        [gitStep("worktree", "prune", "--verbose")],
      ),
    );
  }

  const locked = state.worktrees.filter((wt) => !wt.bare && wt.locked);
  add(
    locked.length === 0
      ? {
          id: "locked-worktrees",
          status: "ok",
          title: "Locked worktrees",
          summary: "None",
          affects: [],
        }
      : {
          id: "locked-worktrees",
          status: "info",
          title: "Locked worktrees",
          summary: locked.map((wt) => wt.path).join(", "),
          affects: [
            "wt remove refuses them and wt mv needs -f until they are unlocked (git worktree unlock)",
          ],
        },
  );
}

/** The branch a bare repo's HEAD names, else the local twin of the remote default. */
async function bareDefaultBranch(
  root: string,
  remoteDefault: string | null,
): Promise<string | null> {
  const head = await gitOutput(["symbolic-ref", "--short", "HEAD"], root);
  const candidates = [head, remoteDefault?.replace(/^origin\//, "")];
  for (const candidate of candidates) {
    if (candidate && (await branchExists(root, candidate))) return candidate;
  }
  return null;
}

async function readGitVersion(cwd: string): Promise<string | null> {
  const output = await gitOutput(["--version"], cwd);
  return output?.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
}

/** Trimmed stdout, or null when git fails or prints nothing. */
async function gitOutput(args: string[], cwd: string): Promise<string | null> {
  const result = await runGit(args, cwd);
  const output = result.stdout.trim();
  return result.exitCode === 0 && output ? output : null;
}
