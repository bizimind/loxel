import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { $ } from "bun";

import type { DiffInfo, FileDiff } from "@/api/diff-model";

import { logger } from "../logger";
import { parseDiffOutput } from "../parsers/diff";
import { mapWithConcurrency } from "./concurrency";
import { readOnlyGitEnv } from "./git-env";
import { validateCommitHash } from "./validation";
import { validateWorktreePath } from "./worktree";

const log = logger.child("git");

/**
 * Resolve a revision to a full commit SHA, or null when it does not name a
 * commit (`<root>^` has no parent).
 *
 * Resolving here — in the repository the diff was computed in — is what makes
 * the answer safe to re-resolve anywhere else. `HEAD` in a linked worktree and
 * `HEAD` in the project repository are different commits; the SHA they resolve
 * to is the same object in the shared store.
 */
export async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
  const spec = `${rev}^{commit}`;
  const result = await $`git -C ${cwd} rev-parse --verify --quiet ${spec}`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  return result.trim() || null;
}

export async function resolveMergeBase(
  cwd: string,
  left: string,
  right: string,
): Promise<string | null> {
  const result = await $`git -C ${cwd} merge-base ${left} ${right}`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  return result.trim() || null;
}

export async function getStagedDiff(cwd: string): Promise<DiffInfo> {
  const baseRef = await resolveCommit(cwd, "HEAD");
  const result = baseRef
    ? await $`git -C ${cwd} diff --cached ${baseRef}`.env(readOnlyGitEnv()).text()
    : await $`git -C ${cwd} diff --cached`.env(readOnlyGitEnv()).text();
  return { files: parseDiffOutput(result), baseRef };
}

export async function getUnstagedDiff(cwd: string): Promise<DiffInfo> {
  const result = await $`git -C ${cwd} diff`.env(readOnlyGitEnv()).text();
  // The old side here is the index, which is not a commit and has no SHA to name.
  return { files: parseDiffOutput(result), baseRef: null };
}

export async function getCommitDiff(cwd: string, commit: string): Promise<DiffInfo> {
  validateCommitHash(commit);
  const result = await $`git -C ${cwd} diff-tree -p --root ${commit}`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  // A root commit has no parent, so the old side is the empty tree: null.
  return { files: parseDiffOutput(result), baseRef: await resolveCommit(cwd, `${commit}^`) };
}

export async function getRangeDiff(cwd: string, range: string): Promise<DiffInfo> {
  const rangeMatch = range.match(/^([a-f0-9]{4,40})?(\.{2,3})([a-f0-9]{4,40})$/i);
  if (!rangeMatch || !rangeMatch[2] || !rangeMatch[3]) {
    throw new Error(`Invalid range format: ${range}`);
  }
  const ref1 = rangeMatch[1];
  const dots = rangeMatch[2];
  const ref2 = rangeMatch[3];
  if (ref1) validateCommitHash(ref1);
  validateCommitHash(ref2);

  const rightRef = (await resolveCommit(cwd, ref2)) ?? ref2;
  let baseRef: string | null;
  let rangeSpec: string;
  if (!ref1) {
    const emptyTree = (
      await $`git hash-object -t tree /dev/null`.env(readOnlyGitEnv()).text()
    ).trim();
    baseRef = null;
    rangeSpec = `${emptyTree}..${rightRef}`;
  } else if (dots === "...") {
    baseRef = await resolveMergeBase(cwd, ref1, rightRef);
    // Preserve Git's own failure when the revisions have no merge base.
    rangeSpec = baseRef ? `${baseRef}..${rightRef}` : `${ref1}...${rightRef}`;
  } else {
    baseRef = await resolveCommit(cwd, ref1);
    rangeSpec = `${baseRef ?? ref1}..${rightRef}`;
  }
  const result = await $`git -C ${cwd} diff ${rangeSpec}`.env(readOnlyGitEnv()).text();
  return { files: parseDiffOutput(result), baseRef };
}

export async function getWorkingTreeDiff(
  cwd: string,
  worktreePath: string,
  base?: string,
): Promise<DiffInfo> {
  await validateWorktreePath(worktreePath, cwd);
  if (base) {
    validateCommitHash(base);
  }
  const ref = base ?? "HEAD";

  const [tracked, untrackedFiles] = await Promise.all([
    (async () => {
      // Resolved against the worktree, not `cwd`: an unqualified HEAD here means
      // the commit this worktree has checked out, which is rarely the project's.
      const baseRef = await resolveCommit(worktreePath, ref);
      const result = await $`git -C ${worktreePath} diff ${baseRef ?? ref}`
        .env(readOnlyGitEnv())
        .text();
      return { baseRef, files: parseDiffOutput(result) };
    })(),
    getUntrackedDiff(worktreePath),
  ]);

  return { files: [...tracked.files, ...untrackedFiles], baseRef: tracked.baseRef };
}

/**
 * Untracked (non-ignored) files, verbatim (`-z`: no C-quoting of unusual names).
 *
 * Entries ending in `/` are nested repositories, which git lists as a directory. They never
 * produced a diff (`git diff --no-index` cannot compare `/dev/null` with a directory), so they
 * are left out rather than surfacing as a gitlink.
 */
async function listUntrackedFiles(worktreePath: string): Promise<string[]> {
  const result = await $`git -C ${worktreePath} ls-files --others --exclude-standard -z`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  return result.split("\0").filter((file) => file && !file.endsWith("/"));
}

/** Upper bound on concurrent `git diff --no-index` processes in the fallback path. */
const FALLBACK_DIFF_CONCURRENCY = 8;

/**
 * Diff every untracked file against nothing — the "new file" half of the working-tree diff.
 *
 * This runs on every status change while an uncommitted diff is open, so it must not scale
 * process count with the number of new files (it used to spawn one `git diff --no-index` per
 * file, all at once). Instead the files are recorded as intent-to-add entries in a throwaway
 * index and diffed in one `git diff`, whose output is byte-identical to the per-file form.
 *
 * Nothing may be written under the git dir: `git add -N` stores (or, when it already exists,
 * freshens the mtime of) the empty blob, and the git-dir watcher treats any `objects/` change
 * as a status/refs/log refresh — which would refetch this diff, forever. The throwaway index and
 * object directory live in a temp dir, so the real repository is only ever read.
 */
async function getUntrackedDiff(worktreePath: string): Promise<FileDiff[]> {
  let files = await listUntrackedFiles(worktreePath);
  if (files.length === 0) return [];

  const scratch = await mkdtemp(path.join(tmpdir(), "loxel-untracked-"));
  try {
    const objects = path.join(scratch, "objects");
    await mkdir(objects);
    const env = {
      ...readOnlyGitEnv(),
      GIT_INDEX_FILE: path.join(scratch, "index"),
      GIT_OBJECT_DIRECTORY: objects,
      // Names are data, not pathspecs: `a*.txt` or `:x` must not glob or trigger magic.
      GIT_LITERAL_PATHSPECS: "1",
    };

    // A file deleted between listing and adding fails the whole `add`; list again once.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) files = await listUntrackedFiles(worktreePath);
      // Never an empty Buffer: Bun's shell does not close stdin for one and git would hang.
      if (files.length === 0) return [];
      await rm(env.GIT_INDEX_FILE, { force: true });
      // No split index (it would write `sharedindex.*` into the git dir) and no hooks
      // (`post-index-change`) for a throwaway index.
      const add =
        await $`git -c core.splitIndex=false -c core.hooksPath=/dev/null -C ${worktreePath} add --intent-to-add --pathspec-from-file=- --pathspec-file-nul < ${Buffer.from(files.join("\0"))}`
          .env(env)
          .nothrow()
          .quiet();
      if (add.exitCode !== 0) {
        log.debug("Intent-to-add of untracked files failed", {
          path: worktreePath,
          attempt,
          stderr: add.stderr.toString().trim(),
        });
        continue;
      }
      // `add -N` never reads contents, so an unreadable file or a missing textconv helper only
      // fails here; the per-file fallback below then loses just that file, not the whole diff.
      const diff = await $`git -C ${worktreePath} diff`.env(env).nothrow().quiet();
      if (diff.exitCode === 0) return parseDiffOutput(diff.stdout.toString());
      log.debug("Diff of intent-to-add untracked files failed", {
        path: worktreePath,
        stderr: diff.stderr.toString().trim(),
      });
      break;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  // Something `git add` refuses outright (e.g. a path outside a sparse-checkout cone), or a file
  // the combined `git diff` cannot read: fall back to one diff per file, so a rare edge case
  // costs speed rather than missing files.
  // Deterministic for a given checkout (it repeats on every refetch), so not warn-level.
  log.debug("Falling back to per-file untracked diffs", {
    path: worktreePath,
    count: files.length,
  });
  const perFile = await mapWithConcurrency(files, FALLBACK_DIFF_CONCURRENCY, async (file) => {
    const diff = await $`git -C ${worktreePath} diff --no-index -- /dev/null ${file}`
      .env(readOnlyGitEnv())
      .nothrow()
      .text();
    return parseDiffOutput(diff);
  });
  return perFile.flat();
}
