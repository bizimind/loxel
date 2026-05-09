import { $ } from "bun";

import type { DiffInfo } from "@/api/diff-model";

import { parseDiffOutput } from "../parsers/diff";
import { FSMONITOR, validateCommitHash } from "./validation";
import { validateWorktreePath } from "./worktree";

export async function getStagedDiff(cwd: string): Promise<DiffInfo> {
  const result = await $`git ${FSMONITOR} -C ${cwd} diff --cached`.text();
  return parseDiffOutput(result);
}

export async function getUnstagedDiff(cwd: string): Promise<DiffInfo> {
  const result = await $`git ${FSMONITOR} -C ${cwd} diff`.text();
  return parseDiffOutput(result);
}

export async function getCommitDiff(cwd: string, commit: string): Promise<DiffInfo> {
  validateCommitHash(commit);
  const result = await $`git -C ${cwd} diff-tree -p --root ${commit}`.nothrow().text();
  return parseDiffOutput(result);
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

  const base = ref1 ?? (await $`git hash-object -t tree /dev/null`.text()).trim();
  const result = await $`git -C ${cwd} diff ${base}${dots}${ref2}`.text();
  return parseDiffOutput(result);
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

  const trackedResult = await $`git ${FSMONITOR} -C ${worktreePath} diff ${ref}`.text();
  const trackedDiff = parseDiffOutput(trackedResult);

  const untrackedResult = await $`git -C ${worktreePath} ls-files --others --exclude-standard`
    .nothrow()
    .text();
  const untrackedFiles = untrackedResult
    .trim()
    .split("\n")
    .filter((f) => f);

  if (untrackedFiles.length === 0) return trackedDiff;

  const untrackedDiffs = await Promise.all(
    untrackedFiles.map(async (file) => {
      const diff = await $`git -C ${worktreePath} diff --no-index -- /dev/null ${file}`
        .nothrow()
        .text();
      return parseDiffOutput(diff);
    }),
  );

  const allFiles = [...trackedDiff.files];
  for (const diff of untrackedDiffs) {
    allFiles.push(...diff.files);
  }
  return { files: allFiles };
}
