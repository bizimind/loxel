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
import { basename, join, relative } from "node:path";

import { compareVersions } from "@bizimind/cli-common";

import {
  branchExists,
  canonicalWorktreesDir,
  disableWorktreeConfigCommands,
  enableWorktreeConfigCommands,
  getWorktreeName,
  isWorktreeConfigBroken,
  isWorktreeConfigStranded,
  listWorktrees,
  pathExists,
  readMeta,
  readWorktreeConfigState,
  resolveRemoteDefault,
  strandedWorktreeConfigKeys,
  resolveRepoRoot,
  runGit,
  worktreeConfigFiles,
  WORKTREE_ID_KEY,
  type Worktree,
  type WorktreeConfigState,
  type WorktreeMeta,
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
  | "worktree-ids"
  | "moved-worktrees"
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
  | "repair-worktrees"
  | "prune-worktrees"
  | "worktree-metadata-on"
  | "worktree-metadata-off"
  | "worktree-ids"
  | "main-worktree";

/** The order `executeInit` applies actions in: each may rely on the ones before it. */
export const INIT_ACTION_ORDER: readonly InitActionId[] = [
  "fetch-refspec",
  "origin-head",
  "repair-worktrees",
  "prune-worktrees",
  "worktree-metadata-on",
  "worktree-metadata-off",
  "worktree-ids",
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
  /**
   * The exact commands it runs, in order, from the repository root. A step wt performs itself,
   * with no command to type (assigning a `wt-id`), is a `#` comment saying what it does.
   */
  commands: string[];
}

/** One thing an action runs. */
export type InitStep =
  /** `onlyWithOriginRefs`: skipped when no `refs/remotes/origin/*` exists (origin has no branches) */
  | { kind: "git"; args: string[]; onlyWithOriginRefs?: true }
  | { kind: "add-worktree"; name: string; branch: string }
  /** Give each worktree at `paths` a `wt-id` if it has none, under wt's metadata lock */
  | { kind: "assign-worktree-ids"; paths: string[] };

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
  /**
   * Stale worktrees whose checkout still exists under the worktrees directory, at `to`: the
   * repository (or the worktrees directory) was moved, and `git worktree repair` reconnects them.
   */
  relocated: Array<{ from: string; to: string }>;
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
  /**
   * Worktrees with a checkout (not the bare repo, not stale) whose metadata has no `wt-id`, read
   * whether or not metadata is on. A section git copied from another worktree does not count.
   */
  withoutId: string[];
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
    relocated: await findRelocated(worktreeConfig.commonDir, worktreesDir, worktrees),
    originUrl,
    fetchRefspecs: refspecs ? refspecs.split("\n") : [],
    hasOriginRefs: Boolean(originRefs),
    originHead,
    remoteDefault,
    defaultBranch: bare ? await bareDefaultBranch(root, remoteDefault) : null,
    worktreeConfig,
    withoutId: await findWorktreesWithoutId(worktreeConfig.commonDir, worktrees),
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
  addWorktreeMetadataCheck(state, add);
  addWorktreeIdsCheck(state, add);
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
  if (step.kind === "assign-worktree-ids") {
    return `# give these worktrees a wt-id: ${step.paths.map(shellArg).join(" ")}`;
  }
  if (step.kind === "add-worktree") {
    return `wt add ${shellArg(step.name)} -b ${shellArg(step.branch)}`;
  }
  const command = ["git", ...step.args].map(shellArg).join(" ");
  return step.onlyWithOriginRefs ? `${command}  # if origin has branches` : command;
}

type AddCheck = (check: Omit<Check, "fixable">, ...offered: PlannedAction[]) => void;

function plannedAction(action: Omit<InitAction, "commands">, steps: InitStep[]): PlannedAction {
  return { ...action, commands: steps.map(describeStep), steps };
}

function gitStep(...args: string[]): InitStep {
  return { kind: "git", args };
}

/** `git remote set-head` fails when origin has no branches (an empty repository), so it is skipped then. */
const SET_ORIGIN_HEAD: InitStep = {
  kind: "git",
  args: ["remote", "set-head", "origin", "--auto"],
  onlyWithOriginRefs: true,
};

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
          SET_ORIGIN_HEAD,
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

  // `set-head --auto` needs origin's default branch fetched, not just some origin ref: a narrow
  // fetch can leave only other branches. Without a known default, fetch everything first.
  const steps = [...(state.remoteDefault ? [] : [gitStep("fetch", "origin")]), SET_ORIGIN_HEAD];
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
  if (!state.hasOriginRefs) {
    return [
      {
        ...base,
        status: "warn",
        summary: `${unset}: nothing has been fetched from origin yet, or origin has no branches`,
        affects: ["wt add starts new branches from HEAD rather than from origin's default branch"],
      },
      action,
    ];
  }
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
  // A moved checkout still has the branch: repairing it, not adding another, is the fix.
  const holder = state.worktrees.find((wt) => !wt.bare && wt.branch === branch);
  const moved = holder && state.relocated.find((entry) => entry.from === holder.path);
  const existing = holder && !holder.prunable ? holder.path : moved?.to;
  if (existing) {
    add({ ...base, status: "ok", summary: `${branch} is checked out at ${existing}`, affects: [] });
    return;
  }

  const path = join(state.worktreesDir, branch);
  const blocked = holder?.prunable || state.worktrees.some((wt) => wt.prunable && wt.path === path);
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
        tradeoffs: [
          `Creates ${path} and runs ${HOOK_INIT} in it, if present`,
          ...(blocked
            ? ["A stale worktree holds the branch or path, so this fails unless it is pruned first"]
            : []),
        ],
      },
      [{ kind: "add-worktree", name: getWorktreeName(path, state.worktreesDir), branch }],
    ),
  );
}

function addWorktreeMetadataCheck(state: RepoState, add: AddCheck): void {
  const { root, worktreeConfig: config } = state;
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
          ...(state.withoutId.length > 0
            ? [`Gives the ${state.withoutId.length} existing worktree(s) without one a wt-id`]
            : []),
          "Undo with: wt init --worktree-metadata off",
        ],
      },
      // Backfilled here so that turning metadata on, by flag or in the walkthrough, always
      // leaves every worktree with an id; `worktree-ids` covers repositories where it is on.
      [...toSteps(enableWorktreeConfigCommands(config)), ...assignIdsStep(state.withoutId)],
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

  if (isWorktreeConfigStranded(config)) {
    const stranded = strandedWorktreeConfigKeys(config).join(" and ");
    add(
      {
        ...base,
        status: "warn",
        summary: `Per-worktree config is off, but ${stranded} is only in ${relative(root, config.mainFile)}, which git ignores while it is off (an interrupted change?)`,
        affects: [`Tools that read ${stranded} from the shared config don't find it`],
      },
      {
        ...disable("Puts the repository back the way it was before per-worktree config"),
        title: `Move ${stranded} back into the shared config`,
        recommended: true,
      },
      enable(false, "Finishes turning per-worktree config on instead"),
    );
    return;
  }
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

function addWorktreeIdsCheck(state: RepoState, add: AddCheck): void {
  // While the config is broken, its repair (`worktree-metadata-on`) gives the ids as well.
  if (!state.worktreeConfig.enabled || isWorktreeConfigBroken(state.worktreeConfig)) return;
  const base = { id: "worktree-ids", title: "Worktree ids" } as const;
  if (state.withoutId.length === 0) {
    add({ ...base, status: "ok", summary: "Every worktree has a wt-id", affects: [] });
    return;
  }
  add(
    {
      ...base,
      status: "warn",
      summary: `Without a wt-id (created before metadata was on, or by plain git worktree add): ${state.withoutId.join(", ")}`,
      affects: [
        "wt meta get <name> wt-id prints nothing for them, so tools that reference worktrees by id cannot refer to them until their metadata is first written",
      ],
    },
    plannedAction(
      {
        id: "worktree-ids",
        check: "worktree-ids",
        title: "Give every worktree without one a wt-id",
        recommended: true,
        recommendation: "Every worktree then has the stable id tools reference it by",
        tradeoffs: ["Writes only wt-meta.wt-id into each worktree's own config"],
      },
      assignIdsStep(state.withoutId),
    ),
  );
}

function assignIdsStep(paths: string[]): InitStep[] {
  return paths.length > 0 ? [{ kind: "assign-worktree-ids", paths }] : [];
}

function addWorktreeListChecks(state: RepoState, add: AddCheck): void {
  const repair =
    state.relocated.length > 0
      ? gitStep("worktree", "repair", ...state.relocated.map((entry) => entry.to))
      : null;
  if (repair) {
    add(
      {
        id: "moved-worktrees",
        status: "warn",
        title: "Moved worktrees",
        summary: `Git lost track of these after the repository moved: ${state.relocated.map((entry) => entry.to).join(", ")}`,
        affects: [
          "git fails inside them, and wt lists them as stale under their old paths",
          "Pruning would drop them from git for good, leaving orphaned checkouts",
        ],
      },
      plannedAction(
        {
          id: "repair-worktrees",
          check: "moved-worktrees",
          title: "Reconnect moved worktrees (git worktree repair)",
          recommended: true,
          recommendation: "Their checkouts are intact; only the paths git recorded are out of date",
          tradeoffs: ["Rewrites the paths in git's records of these worktrees, nothing else"],
        },
        [repair],
      ),
    );
  }

  const movedPaths = new Set(state.relocated.map((entry) => entry.from));
  const stale = state.worktrees.filter((wt) => !wt.bare && wt.prunable && !movedPaths.has(wt.path));
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
            ...(repair
              ? ["Reconnects the moved worktrees first, since pruning would drop them too"]
              : []),
          ],
        },
        // `git worktree prune` drops every stale entry, so moved ones are reconnected first.
        [...(repair ? [repair] : []), gitStep("worktree", "prune", "--verbose")],
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

/**
 * Stale worktrees whose checkout is still in the worktrees directory under its old relative
 * path, typically because the repository directory was moved. A candidate counts only when its
 * `.git` file names an admin dir of this repository that recorded the stale path, so an
 * unrelated checkout is never matched.
 */
async function findRelocated(
  commonDir: string,
  worktreesDir: string,
  worktrees: Worktree[],
): Promise<RepoState["relocated"]> {
  const relocated: RepoState["relocated"] = [];
  for (const wt of worktrees) {
    if (wt.bare || !wt.prunable) continue;
    const segments = wt.path.split("/").filter(Boolean);
    for (let count = 1; count <= segments.length; count++) {
      const candidate = join(worktreesDir, ...segments.slice(-count));
      if (candidate !== wt.path && (await isCheckoutOf(candidate, commonDir, wt.path))) {
        relocated.push({ from: wt.path, to: candidate });
        break;
      }
    }
  }
  return relocated;
}

/** Whether `dir` is the checkout registered in `commonDir` as living at `recordedPath`. */
async function isCheckoutOf(
  dir: string,
  commonDir: string,
  recordedPath: string,
): Promise<boolean> {
  const dotGit = Bun.file(join(dir, ".git"));
  if (!(await dotGit.exists())) return false;
  const pointer = (await dotGit.text().catch(() => "")).match(/^gitdir: (.+)$/m)?.[1]?.trim();
  if (!pointer) return false;
  const gitdirFile = Bun.file(join(commonDir, "worktrees", basename(pointer), "gitdir"));
  if (!(await gitdirFile.exists())) return false;
  return (await gitdirFile.text()).trim() === join(recordedPath, ".git");
}

async function findWorktreesWithoutId(commonDir: string, worktrees: Worktree[]): Promise<string[]> {
  const files = await worktreeConfigFiles(commonDir, worktrees);
  const missing = await Promise.all(
    worktrees.map(async (wt) => {
      const file = files.get(wt.path);
      if (wt.bare || wt.prunable || !file) return false;
      // An unreadable file counts as missing: the fix then fails with git's own error.
      const meta = await readMeta(commonDir, file).catch((): WorktreeMeta => ({}));
      return !meta[WORKTREE_ID_KEY];
    }),
  );
  return worktrees.filter((_, i) => missing[i]).map((wt) => wt.path);
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
