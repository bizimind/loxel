import { $ } from "bun";

import type { DiffInfo } from "@/api/diff-model";

import { parseDiffOutput } from "../parsers/diff";
import { FSMONITOR, readOnlyGitEnv } from "./git-env";
import { validateCommitHash } from "./validation";
import { validateWorktreePath } from "./worktree";

/**
 * Resolve a revision to a full commit SHA, or null when it does not name a
 * commit (`<root>^` has no parent).
 *
 * Resolving here — in the repository the diff was computed in — is what makes
 * the answer safe to re-resolve anywhere else. `HEAD` in a linked worktree and
 * `HEAD` in the project repository are different commits; the SHA they resolve
 * to is the same object in the shared store.
 */
async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
  const spec = `${rev}^{commit}`;
  const result = await $`git -C ${cwd} rev-parse --verify --quiet ${spec}`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  return result.trim() || null;
}

async function resolveMergeBase(cwd: string, left: string, right: string): Promise<string | null> {
  const result = await $`git -C ${cwd} merge-base ${left} ${right}`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  return result.trim() || null;
}

export async function getStagedDiff(cwd: string): Promise<DiffInfo> {
  const baseRef = await resolveCommit(cwd, "HEAD");
  const result = baseRef
    ? await $`git ${FSMONITOR} -C ${cwd} diff --cached ${baseRef}`.env(readOnlyGitEnv()).text()
    : await $`git ${FSMONITOR} -C ${cwd} diff --cached`.env(readOnlyGitEnv()).text();
  return { files: parseDiffOutput(result), baseRef };
}

export async function getUnstagedDiff(cwd: string): Promise<DiffInfo> {
  const result = await $`git ${FSMONITOR} -C ${cwd} diff`.env(readOnlyGitEnv()).text();
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

  // Resolved against the worktree, not `cwd`: an unqualified HEAD here means
  // the commit this worktree has checked out, which is rarely the project's.
  const baseRef = await resolveCommit(worktreePath, ref);
  const diffRef = baseRef ?? ref;

  const trackedResult = await $`git ${FSMONITOR} -C ${worktreePath} diff ${diffRef}`
    .env(readOnlyGitEnv())
    .text();
  const trackedFiles = parseDiffOutput(trackedResult);

  const untrackedResult = await $`git -C ${worktreePath} ls-files --others --exclude-standard`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  const untrackedFiles = untrackedResult
    .trim()
    .split("\n")
    .filter((f) => f);

  if (untrackedFiles.length === 0) return { files: trackedFiles, baseRef };

  const untrackedDiffs = await Promise.all(
    untrackedFiles.map(async (file) => {
      const diff = await $`git -C ${worktreePath} diff --no-index -- /dev/null ${file}`
        .env(readOnlyGitEnv())
        .nothrow()
        .text();
      return parseDiffOutput(diff);
    }),
  );

  const allFiles = [...trackedFiles];
  for (const files of untrackedDiffs) {
    allFiles.push(...files);
  }
  return { files: allFiles, baseRef };
}
