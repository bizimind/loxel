import { isRepoTrusted } from "../repo-trust";
import { repoFilterDrivers } from "./repo-filter-drivers";

/**
 * Environment and shared arguments for git invocations.
 *
 * These live in their own module rather than in `validation.ts` so there is exactly one source
 * of truth for how Loxel shells out to git, independent of argument validation.
 */

// Loxel never passes `core.fsmonitor=true`: under GIT_OPTIONAL_LOCKS=0 it can't save its token, and
// it would leave a daemon behind for every worktree and submodule. Whether fsmonitor runs on a read
// is the user's Git configuration in a trusted repository; everywhere else it is off.

/** The setting as an argument, for a caller that builds its own environment. */
export const FSMONITOR_OFF = ["-c", "core.fsmonitor=false"];

/**
 * Global options for every command that compares the working tree (status, working-tree diffs).
 * Placed before the subcommand: `git -C <dir> ${SUBMODULE_GITLINK_ONLY} status ...`.
 *
 * Git otherwise decides whether each submodule is dirty by running a status inside it,
 * recursively, which dominates the cost in repositories with many submodules (4s against 0.3s
 * for one with 76). With it a submodule shows as changed only when its checked-out commit
 * differs from the recorded one; edits and untracked files inside it are not reported. A
 * design decision: Loxel reports submodules at the gitlink level only.
 *
 * Set as the `diff.ignoreSubmodules` default rather than passed as `--ignore-submodules=dirty`:
 * the flag would override a repository's own `submodule.<name>.ignore` (an `all` submodule would
 * reappear when its commit moves), whereas per-submodule configuration takes precedence over
 * this default.
 */
export const SUBMODULE_GITLINK_ONLY = ["-c", "diff.ignoreSubmodules=dirty"];

/**
 * Environment for read-only git commands.
 *
 * `GIT_OPTIONAL_LOCKS=0` breaks a feedback loop with the git-directory FileWatcher. A read-only
 * `git status` still refreshes the index and writes `index.lock` on *every* invocation; the
 * watcher classifies that as an index change and asks for another status, once per subscribed
 * worktree, forever. With this variable set the read paths produce no writes in the git dir at
 * all. Git ignores it wherever the lock is mandatory, so it is a no-op for mutating commands —
 * but it is only set here, on the read-only modules, to keep that guarantee explicit.
 *
 * `core.fsmonitor=false` is set here as well, so every read-only command has it in one place,
 * unless `cwd` is in a trusted repository, whose fsmonitor stays the user's choice; so are the
 * other programs a repository's config can make a read run ({@link untrustedReadOverrides}). Without a `cwd`
 * it is always set. `GIT_CONFIG_PARAMETERS` is what `git -c` itself sets, with the same precedence,
 * and every git reads this form, while `GIT_CONFIG_COUNT` needs git 2.31. An inherited value is kept.
 *
 * Returned as a fresh object because a spawn's `env` REPLACES the child environment instead of
 * merging into it: without spreading `process.env` git would lose `PATH`/`HOME` and fail in ways
 * that no unit test observes.
 */
export function readOnlyGitEnv(cwd?: string): Record<string, string> {
  const env = inheritedGitEnv();
  if (cwd !== undefined && isRepoTrusted(cwd)) return { ...env, GIT_OPTIONAL_LOCKS: "0" };
  const overrides = [
    configParameter("core.fsmonitor", "false"),
    ...(cwd === undefined ? [] : untrustedReadOverrides(cwd)),
  ];
  const inherited = env.GIT_CONFIG_PARAMETERS;
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_PARAMETERS: [...(inherited ? [inherited] : []), ...overrides].join(" "),
  };
}

/**
 * What else a read in an untrusted repository turns off: signature checks, which run the program
 * the config names, and every filter driver the repository's config defines, whose commands git
 * runs on files it compares with the index. An empty command makes git pass the content through,
 * and `required=false` keeps that from failing. Diff drivers need flags instead
 * ({@link diffProgramArgs}), since git fails on an empty one.
 */
function untrustedReadOverrides(cwd: string): string[] {
  const drivers = repoFilterDrivers(cwd);
  // Drivers that could not all be found cannot all be turned off, so git is made to refuse the read.
  if (drivers === null) return [REFUSE_TO_READ];
  return [
    configParameter("log.showSignature", "false"),
    // A read that refreshes the index runs `post-index-change`, whatever GIT_OPTIONAL_LOCKS says.
    configParameter("core.hooksPath", "/dev/null"),
    ...drivers.flatMap((name) => [
      configParameter(`filter.${name}.clean`, ""),
      configParameter(`filter.${name}.smudge`, ""),
      configParameter(`filter.${name}.process`, ""),
      configParameter(`filter.${name}.required`, "false"),
    ]),
  ];
}

/** An unterminated entry: git stops with "bogus format in GIT_CONFIG_PARAMETERS" and runs nothing. */
const REFUSE_TO_READ = "'";

/**
 * One `GIT_CONFIG_PARAMETERS` entry. A key holding `=` (a driver name may) takes the
 * `'key'='value'` form of git 2.31 and later, since the older `'key=value'` splits at the first `=`.
 */
function configParameter(key: string, value: string): string {
  return key.includes("=")
    ? `${shellQuote(key)}=${shellQuote(value)}`
    : shellQuote(`${key}=${value}`);
}

/** Single-quoted the way git's `sq_quote` writes and its `sq_dequote` reads. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Flags for the reads that print a diff, so its output is git's own patch format, which Loxel
 * parses: never an external diff program (`diff.external`, a driver's `command`), and in an
 * untrusted repository no `textconv` program and {@link untrustedSubmoduleArgs}. A trusted
 * repository's textconv still applies, as in the user's own `git diff`.
 */
export function diffProgramArgs(cwd: string): string[] {
  if (isRepoTrusted(cwd)) return ["--no-ext-diff"];
  return ["--no-ext-diff", "--no-textconv", ...untrustedSubmoduleArgs(cwd)];
}

/**
 * For the reads that compare the working tree in an untrusted repository: submodules compared by
 * commit only, which a submodule's own `ignore` setting cannot undo as it can
 * {@link SUBMODULE_GITLINK_ONLY}'s default, so git never reads a submodule's own config, which no
 * override here covers.
 */
export function untrustedSubmoduleArgs(cwd: string): string[] {
  return isRepoTrusted(cwd) ? [] : ["--ignore-submodules=dirty"];
}

/** The server's current environment, for commands with no special needs. */
export function inheritedGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
