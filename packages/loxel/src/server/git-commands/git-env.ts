import { isRepoTrusted } from "../repo-trust";
import { GitCommandError, inheritedGitEnv, runGit } from "./run-git";

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
 * `core.fsmonitor=false` and `log.showSignature=false` (which would run the configured signature
 * program on every `git log`) are set here as well, so every read-only command has them in one
 * place, unless `cwd` is in a trusted repository, whose settings stay the user's choice. Without a
 * `cwd` they are always set. `GIT_CONFIG_PARAMETERS` is what `git -c` itself sets, with the same
 * precedence, and every git reads this form, while `GIT_CONFIG_COUNT` needs git 2.31. An inherited
 * value is kept.
 *
 * Returned as a fresh object because a spawn's `env` REPLACES the child environment instead of
 * merging into it: without spreading `process.env` git would lose `PATH`/`HOME` and fail in ways
 * that no unit test observes.
 */
export function readOnlyGitEnv(cwd?: string): Record<string, string> {
  const env = inheritedGitEnv();
  if (cwd !== undefined && isRepoTrusted(cwd)) return { ...env, GIT_OPTIONAL_LOCKS: "0" };
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_PARAMETERS: withConfigParameters(env.GIT_CONFIG_PARAMETERS, UNTRUSTED_READ_CONFIG),
  };
}

const UNTRUSTED_READ_CONFIG = [
  configParameter("core.fsmonitor", "false"),
  configParameter("log.showSignature", "false"),
];

/**
 * {@link readOnlyGitEnv} for the commands that read working-tree content: status and the diffs
 * against the working tree. Git hashes such a file through the clean (or process) command of its
 * filter driver, so in an untrusted repository every filter driver that the repository's own config
 * defines gets empty commands, and its files are compared as stored. Drivers from the user's own
 * global or system config, such as git-lfs, keep working.
 */
export async function worktreeReadEnv(cwd: string): Promise<Record<string, string>> {
  const env = readOnlyGitEnv(cwd);
  if (isRepoTrusted(cwd)) return env;
  const overrides = (await repoFilterDrivers(cwd, env)).flatMap((name) => [
    configParameter(`filter.${name}.clean`, ""),
    configParameter(`filter.${name}.smudge`, ""),
    configParameter(`filter.${name}.process`, ""),
    // Otherwise git fails on a required filter with no command instead of passing content through.
    configParameter(`filter.${name}.required`, "false"),
  ]);
  return {
    ...env,
    GIT_CONFIG_PARAMETERS: withConfigParameters(env.GIT_CONFIG_PARAMETERS, overrides),
  };
}

/**
 * The names of the filter drivers that the repository's own config files (`config`,
 * `config.worktree` and the files they include) define. Git reads the config itself, which runs
 * nothing, so the names are exactly the ones it would use.
 */
async function repoFilterDrivers(cwd: string, env: Record<string, string>): Promise<string[]> {
  const result = await runGit(
    ["config", "--show-scope", "--name-only", "-z", "--get-regexp", String.raw`^filter\.`],
    { cwd, env, nothrow: true },
  );
  // Exit code 1: no filter keys at all.
  if (result.exitCode === 1) return [];
  // A config git cannot read would leave drivers unknown, so the read fails rather than run them.
  if (result.exitCode !== 0) throw new GitCommandError(result);
  // `-z` with `--show-scope`: scope and key, each NUL-terminated.
  const fields = result.stdout.split("\0");
  const names = new Set<string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [scope, key] = [fields[i], fields[i + 1] ?? ""];
    if (scope !== "local" && scope !== "worktree") continue;
    // `filter.<name>.<variable>`; the name may hold dots, the variable cannot.
    const rest = key.slice("filter.".length);
    const end = rest.lastIndexOf(".");
    if (end >= 0) names.add(rest.slice(0, end));
  }
  return [...names];
}

/**
 * Flags for the reads that print a diff, whose output Loxel parses as git's own patch format: never
 * an external diff program, submodule changes as a plain gitlink patch (a `diff.submodule` setting
 * would instead run a log or a diff inside the submodule), and in an untrusted repository no
 * `textconv` program either. (Git fails on an empty textconv command, so these are flags rather
 * than config.)
 */
export function diffProgramArgs(cwd: string): string[] {
  const always = ["--no-ext-diff", "--submodule=short"];
  return isRepoTrusted(cwd) ? always : [...always, "--no-textconv"];
}

/**
 * For the reads that compare the working tree in an untrusted repository: submodules compared by
 * commit only. {@link SUBMODULE_GITLINK_ONLY} is only a default that a submodule's own `ignore`
 * setting overrides, and git would then run a status inside the submodule, whose own config none of
 * the overrides here cover.
 */
export function untrustedSubmoduleArgs(cwd: string): string[] {
  return isRepoTrusted(cwd) ? [] : ["--ignore-submodules=dirty"];
}

function withConfigParameters(inherited: string | undefined, entries: string[]): string {
  return [...(inherited ? [inherited] : []), ...entries].join(" ");
}

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
  return `'${text.replaceAll("'", String.raw`'\''`)}'`;
}
