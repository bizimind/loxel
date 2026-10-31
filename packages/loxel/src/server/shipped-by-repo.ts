import { existsSync, readdirSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { isDirectory } from "@/fs-utils";

import { readOnlyGitEnv } from "./git-commands";
import { logger } from "./logger";
import { measureSpawn } from "./spawn-metrics";

const log = logger.child("server");

/** `runGit` exit code when git could not be started (missing binary, unusable directory). */
const GIT_SPAWN_FAILED = -1;

// The trust rule for what Loxel runs out of a worktree: a project-provided binary or environment
// must not be something the repository itself ships, or opening a file would run repository code.

/**
 * Whether the repository ships any part of the environment at `envPath`: a file git tracks inside
 * it, or the `executable` about to run from it (or what its symlinks resolve to), including in a
 * submodule or nested repository. Real environments are never committed, and whatever runs from
 * one (Loxel and basedpyright running the interpreter, format-on-save running ruff or black) would
 * otherwise run repository code, through the executable itself or files it loads such as a `.pth`
 * hook in `site-packages`. The one trust rule for environments, shared by the resolver, the
 * formatter, terminals and ruff's language server, with one cache (see {@link isTrackedByGit}).
 */
export async function isEnvShippedByRepo(
  wtPath: string,
  envPath: string,
  executable: string,
): Promise<boolean> {
  const targets = [...(await envTargets(wtPath, envPath)), executable];
  const shipped = await Promise.all(targets.map((target) => isShippedByRepo(wtPath, target)));
  return shipped.some(Boolean);
}

/**
 * What of the environment at `envPath` to ask git about: the whole directory, or, when the
 * worktree lies inside it (an environment created at the repository root, `python -m venv .`),
 * only the environment's own entries, since the directory then also holds the repository's files.
 */
async function envTargets(wtPath: string, envPath: string): Promise<string[]> {
  const resolveReal = (target: string) => realpath(target).catch(() => target);
  const [realWtPath, realEnvPath] = await Promise.all([resolveReal(wtPath), resolveReal(envPath)]);
  if (!isInside(wtPath, envPath) && !isInside(realWtPath, realEnvPath)) return [envPath];
  const libDir = path.join(envPath, "lib");
  let libEntries: string[] = [];
  try {
    libEntries = readdirSync(libDir);
  } catch {
    // No `lib` directory: nothing installed there to check.
  }
  return [
    path.join(envPath, "pyvenv.cfg"),
    path.join(envPath, "conda-meta"),
    path.join(envPath, "Lib", "site-packages"),
    ...libEntries
      .filter((name) => name.startsWith("python"))
      .map((name) => path.join(libDir, name, "site-packages")),
  ].filter((target) => existsSync(target));
}

/**
 * Whether `target` (a file or directory, or what its symlinks resolve to) is, or for a directory
 * contains, something git tracks in the worktree, including in a submodule or nested repository.
 * A path that cannot be checked (removed meanwhile, or git failing) counts as tracked, so the
 * caller moves on to its next candidate.
 */
export async function isShippedByRepo(wtPath: string, target: string): Promise<boolean> {
  try {
    const candidates = new Set([target, await realpath(target)]);
    const root = path.resolve(wtPath);
    const tracked = await Promise.all([...candidates].map((file) => isTrackedByGit(root, file)));
    return tracked.some(Boolean);
  } catch (err) {
    log.debug("Could not check whether git tracks a path; treating it as tracked", {
      target,
      error: err,
    });
    return true;
  }
}

/** A repository's top level and its index file, whose changes invalidate cached answers. */
interface RepoInfo {
  toplevel: string;
  indexFile: string;
}

interface WorktreeRepo extends RepoInfo {
  realWtPath: string;
}

/** The worktree's own repository by worktree path, looked up once while its git dir exists. */
const worktreeRepos = new Map<string, Promise<WorktreeRepo | null | typeof GIT_SPAWN_FAILED>>();

/** A cached {@link isTrackedByGit} answer, valid while the indexes it read are unchanged. */
interface TrackedAnswer {
  tracked: boolean;
  indexStamps: Array<readonly [file: string, stamp: string]>;
}

/** Answers by worktree and physical path. */
const trackedAnswers = new Map<string, TrackedAnswer>();
/**
 * Questions being asked, by key and the worktree index they started from, so concurrent checks
 * of one path share a git run but a check made after the index changed does not join an older one.
 */
const trackedQuestions = new Map<string, Promise<boolean>>();

/**
 * Asks the innermost repository containing `filePath`, since a submodule or nested repository
 * tracks its own files and the worktree's index does not list them. For a real directory that is
 * the directory's own repository if it is one (a venv can be a repository itself), and any
 * tracked file inside counts. Git is asked about the physical path (parent directory resolved,
 * the entry itself kept, so a committed symlink still counts) wherever it is: a committed symlink
 * can reach another checkout of the same repository. Inside a git worktree, any answer other than
 * a clear "untracked" counts as tracked (fail closed); outside it, a path in no repository is
 * untracked.
 *
 * Clear answers are cached per physical path until the index file of the worktree's or the
 * innermost repository changes: every commit, checkout, pull, `git add` or submodule update
 * rewrites one of those, so callers ask on every use without spawning git each time.
 */
async function isTrackedByGit(wtPath: string, filePath: string): Promise<boolean> {
  const worktreeRepo = await worktreeRepoOf(wtPath);
  if (worktreeRepo === GIT_SPAWN_FAILED) return true;
  // Not a repository at all, so nothing in it can be committed.
  if (!worktreeRepo) return false;

  const physical = path.join(await realpath(path.dirname(filePath)), path.basename(filePath));
  const key = `${wtPath}\0${physical}`;
  const known = trackedAnswers.get(key);
  if (known && (await stampsMatch(known.indexStamps))) return known.tracked;
  // Stamped before asking, so a change made while git runs invalidates the answer.
  const worktreeStamp = await stampIndexes([worktreeRepo.indexFile]);
  const questionKey = `${key}\0${worktreeStamp[0]![1]}`;
  let question = trackedQuestions.get(questionKey);
  if (!question) {
    question = askGit(worktreeRepo, physical, key, worktreeStamp).finally(() =>
      trackedQuestions.delete(questionKey),
    );
    trackedQuestions.set(questionKey, question);
  }
  return question;
}

async function askGit(
  worktreeRepo: WorktreeRepo,
  physical: string,
  key: string,
  worktreeStamp: TrackedAnswer["indexStamps"],
): Promise<boolean> {
  const lookupDir = (await isRealDirectory(physical)) ? physical : path.dirname(physical);
  const innermost = await repoAt(lookupDir);
  if (innermost === GIT_SPAWN_FAILED || !innermost) {
    const tracked = isInside(physical, worktreeRepo.realWtPath);
    // Inside the worktree this is git failing (fail closed), not an answer worth keeping.
    if (!tracked) trackedAnswers.set(key, { tracked, indexStamps: worktreeStamp });
    return tracked;
  }
  const indexStamps = [...worktreeStamp, ...(await stampIndexes([innermost.indexFile]))];
  const listed = await runGit(innermost.toplevel, ["ls-files", "--error-unmatch", "--", physical]);
  // `--error-unmatch` exits 1 for an untracked path; anything else is tracked or an error.
  if (listed.exitCode !== 0 && listed.exitCode !== 1) return true;
  const tracked = listed.exitCode === 0;
  trackedAnswers.set(key, { tracked, indexStamps });
  return tracked;
}

async function worktreeRepoOf(
  wtPath: string,
): Promise<WorktreeRepo | null | typeof GIT_SPAWN_FAILED> {
  const cached = worktreeRepos.get(wtPath);
  if (cached) {
    const repo = await cached;
    if (repo && repo !== GIT_SPAWN_FAILED && isDirectory(path.dirname(repo.indexFile))) return repo;
    // A failed or outdated lookup; the first caller to notice replaces it.
    if (worktreeRepos.get(wtPath) === cached) worktreeRepos.delete(wtPath);
  }
  let lookup = worktreeRepos.get(wtPath);
  if (!lookup) {
    lookup = lookUpWorktreeRepo(wtPath);
    worktreeRepos.set(wtPath, lookup);
  }
  return lookup;
}

async function lookUpWorktreeRepo(
  wtPath: string,
): Promise<WorktreeRepo | null | typeof GIT_SPAWN_FAILED> {
  const realWtPath = await realpath(wtPath).catch(() => null);
  if (!realWtPath) return GIT_SPAWN_FAILED;
  const repo = await repoAt(realWtPath);
  return repo === GIT_SPAWN_FAILED || !repo ? repo : { ...repo, realWtPath };
}

/** The repository containing `dir`, or null when it is in none. */
async function repoAt(dir: string): Promise<RepoInfo | null | typeof GIT_SPAWN_FAILED> {
  const result = await runGit(dir, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
  if (result.exitCode === GIT_SPAWN_FAILED) return GIT_SPAWN_FAILED;
  const [toplevel, gitDir] = result.stdout.split("\n");
  if (result.exitCode !== 0 || !toplevel || !gitDir) return null;
  return { toplevel, indexFile: path.join(gitDir, "index") };
}

async function stampIndexes(files: string[]): Promise<Array<readonly [string, string]>> {
  return Promise.all(files.map(async (file) => [file, await fileStamp(file)] as const));
}

async function stampsMatch(stamps: TrackedAnswer["indexStamps"]): Promise<boolean> {
  const current = await Promise.all(stamps.map(([file]) => fileStamp(file)));
  return current.every((stamp, i) => stamp === stamps[i]![1]);
}

/** Git replaces the index file on every write, so its identity changes with its content. */
async function fileStamp(file: string): Promise<string> {
  try {
    const info = await stat(file);
    return `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
  } catch {
    return "missing";
  }
}

/** A directory that is not a symlink (`lstat`), so a committed symlink is asked about as itself. */
async function isRealDirectory(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function runGit(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  try {
    const proc = measureSpawn("git", () =>
      Bun.spawn(["git", "-C", cwd, ...args], {
        env: readOnlyGitEnv(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      }),
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { exitCode, stdout };
  } catch {
    return { exitCode: GIT_SPAWN_FAILED, stdout: "" };
  }
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}
