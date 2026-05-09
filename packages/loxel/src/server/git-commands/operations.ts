import { $ } from "bun";

import { logger } from "../logger";
import { FSMONITOR, validateCommitHash, validateRefName } from "./validation";

const log = logger.child("git");

export async function createCommit(cwd: string, message: string): Promise<string> {
  log.debug(`Creating commit (${message.length} char message)`);
  await $`git ${FSMONITOR} -C ${cwd} commit -m ${message}`.quiet();
  const result = await $`git -C ${cwd} rev-parse HEAD`.text();
  return result.trim();
}

export async function checkout(cwd: string, ref: string): Promise<void> {
  validateRefName(ref);
  log.debug(`Checking out ${ref}`);
  await $`git ${FSMONITOR} -C ${cwd} checkout ${ref}`.quiet();
}

export async function reset(
  cwd: string,
  commit: string,
  mode: "soft" | "mixed" | "hard",
): Promise<void> {
  validateCommitHash(commit);
  log.debug(`Resetting --${mode} to ${commit.slice(0, 8)}`);
  await $`git ${FSMONITOR} -C ${cwd} reset --${mode} ${commit}`.quiet();
}

export async function cherryPick(cwd: string, commits: string[]): Promise<void> {
  for (const commit of commits) {
    validateCommitHash(commit);
  }
  log.debug(
    `Cherry-picking ${commits.length} commit(s): ${commits.map((c) => c.slice(0, 8)).join(", ")}`,
  );
  await $`git ${FSMONITOR} -C ${cwd} cherry-pick ${commits}`.quiet();
}

export async function revert(cwd: string, commits: string[]): Promise<void> {
  for (const commit of commits) {
    validateCommitHash(commit);
  }
  log.debug(
    `Reverting ${commits.length} commit(s): ${commits.map((c) => c.slice(0, 8)).join(", ")}`,
  );
  await $`git ${FSMONITOR} -C ${cwd} revert --no-commit ${commits}`.quiet();
}

export async function createBranch(cwd: string, name: string, startPoint?: string): Promise<void> {
  log.debug(`Creating branch ${name}${startPoint ? ` from ${startPoint}` : ""}`);
  validateRefName(name);
  if (startPoint) {
    validateRefName(startPoint);
    await $`git -C ${cwd} branch ${name} ${startPoint}`.quiet();
  } else {
    await $`git -C ${cwd} branch ${name}`.quiet();
  }
}

export async function deleteBranch(cwd: string, name: string, force = false): Promise<void> {
  log.debug(`Deleting branch ${name}${force ? " (force)" : ""}`);
  validateRefName(name);
  const flag = force ? "-D" : "-d";
  await $`git -C ${cwd} branch ${flag} ${name}`.quiet();
}

export async function renameBranch(cwd: string, oldName: string, newName: string): Promise<void> {
  log.debug(`Renaming branch ${oldName} to ${newName}`);
  validateRefName(oldName);
  validateRefName(newName);
  await $`git -C ${cwd} branch -m ${oldName} ${newName}`.quiet();
}

export async function stash(cwd: string, message?: string): Promise<void> {
  if (message) {
    await $`git ${FSMONITOR} -C ${cwd} stash push -m ${message}`.quiet();
  } else {
    await $`git ${FSMONITOR} -C ${cwd} stash push`.quiet();
  }
}

export async function stashApply(cwd: string, index: number): Promise<void> {
  await $`git ${FSMONITOR} -C ${cwd} stash apply stash@{${index}}`.quiet();
}

export async function stashPop(cwd: string, index: number): Promise<void> {
  await $`git ${FSMONITOR} -C ${cwd} stash pop stash@{${index}}`.quiet();
}

export async function stashDrop(cwd: string, index: number): Promise<void> {
  await $`git -C ${cwd} stash drop stash@{${index}}`.quiet();
}
