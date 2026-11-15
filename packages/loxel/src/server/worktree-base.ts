/**
 * Where a worktree Loxel creates starts. A new branch starts from origin's default branch, which
 * `wt` resolves as last fetched and never fetches itself, so Loxel fetches that one branch first.
 * A child worktree can instead be stacked on its parent's current commit, which the New worktree
 * dialog shows next to how far it is behind the default.
 */
import { resolveRemoteDefault } from "@bizimind/wt/lib";

import type { WorktreeBasePlan } from "@/api/project-model";

import { gitText, readOnlyGitEnv, runGit } from "./git-commands";
import { logger } from "./logger";
import { buildSpawnEnv } from "./shell-env";

const log = logger.child("worktrees");

/**
 * Long enough for a fetch after weeks away on a slow link, short enough that an unreachable or
 * hanging remote holds a create back only briefly.
 */
export const FETCH_TIMEOUT_MS = 15_000;

/** Fetches in progress by repository, so concurrent creates in one repository share one fetch. */
const fetching = new Map<string, Promise<void>>();

/**
 * Bring origin's default branch (`origin/main`) up to date before a worktree is created from it.
 * Best effort: when it fails (offline, no remote, auth, timeout) the create goes ahead from the
 * last fetched ref and the failure is only logged. A repository with no origin default is not
 * fetched, since its worktrees start from `HEAD`.
 */
export function fetchRemoteDefault(
  repoPath: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<void> {
  const running = fetching.get(repoPath);
  if (running) return running;
  const fetch = runFetch(repoPath, timeoutMs).finally(() => fetching.delete(repoPath));
  fetching.set(repoPath, fetch);
  return fetch;
}

async function runFetch(repoPath: string, timeoutMs: number): Promise<void> {
  try {
    const ref = await resolveRemoteDefault(repoPath);
    // An origin/HEAD pointed at another remote's ref is not origin's branch to fetch.
    if (!ref?.startsWith("origin/")) return;
    const branch = ref.slice("origin/".length);
    // Only the default branch, into its remote-tracking ref whatever the configured refspec says,
    // leaving FETCH_HEAD to the user's own fetches, and without submodules (which may live on
    // other hosts) or the auto-maintenance a fetch ends with.
    const result = await runGit(
      [
        "fetch",
        "--quiet",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "origin",
        `+refs/heads/${branch}:refs/remotes/${ref}`,
      ],
      { cwd: repoPath, env: fetchEnv(), stdin: new Uint8Array(), timeoutMs, nothrow: true },
    );
    if (result.exitCode === 0) {
      log.info(`Fetched ${ref} before creating a worktree`);
      return;
    }
    log.warn(`Could not fetch ${ref}; creating the worktree from it as last fetched`, {
      error: result.stderr.trim(),
    });
  } catch (error) {
    log.warn("Could not fetch origin's default branch; creating the worktree without it", {
      error,
    });
  }
}

/**
 * The user's shell environment, so credential helpers and ssh-agent work as in their terminal,
 * with git's and Git Credential Manager's prompts off: nobody is waiting to answer them, and a
 * sign-in window would be closed by the timeout.
 */
function fetchEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(buildSpawnEnv())) {
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  return env;
}

/**
 * Where a new worktree would start: the remote default, and for a child, its parent's commit and
 * how many commits that is behind the remote default as last fetched.
 */
export async function planWorktreeBase(
  repoPath: string,
  parentCommit: string | undefined,
): Promise<WorktreeBasePlan> {
  const remoteDefault = await resolveRemoteDefault(repoPath);
  if (parentCommit === undefined) return { remoteDefault, parent: null };
  return {
    remoteDefault,
    parent: {
      commit: parentCommit,
      behind: remoteDefault ? await countBehind(repoPath, parentCommit, remoteDefault) : null,
    },
  };
}

/** Commits on `ref` that `commit` lacks; null when git cannot tell. */
async function countBehind(repoPath: string, commit: string, ref: string): Promise<number | null> {
  const output = await gitText(["rev-list", "--count", "--end-of-options", `${commit}..${ref}`], {
    cwd: repoPath,
    env: readOnlyGitEnv(repoPath),
    nothrow: true,
  });
  const count = Number.parseInt(output.trim(), 10);
  return Number.isNaN(count) ? null : count;
}
