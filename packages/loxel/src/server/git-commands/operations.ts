import { logger } from "../logger";
import { gitText, runGit } from "./run-git";
import { validateCommitHash, validateRefName } from "./validation";

const log = logger.child("git");

export async function createCommit(cwd: string, message: string): Promise<string> {
  log.debug(`Creating commit (${message.length} char message)`);
  await runGit(["commit", "-m", message], { cwd });
  const result = await gitText(["rev-parse", "HEAD"], { cwd });
  return result.trim();
}

export async function checkout(cwd: string, ref: string): Promise<void> {
  validateRefName(ref);
  log.debug(`Checking out ${ref}`);
  await runGit(["checkout", ref], { cwd });
}

export async function reset(
  cwd: string,
  commit: string,
  mode: "soft" | "mixed" | "hard",
): Promise<void> {
  validateCommitHash(commit);
  log.debug(`Resetting --${mode} to ${commit.slice(0, 8)}`);
  await runGit(["reset", `--${mode}`, commit], { cwd });
}

export async function cherryPick(cwd: string, commits: string[]): Promise<void> {
  for (const commit of commits) {
    validateCommitHash(commit);
  }
  log.debug(
    `Cherry-picking ${commits.length} commit(s): ${commits.map((c) => c.slice(0, 8)).join(", ")}`,
  );
  await runGit(["cherry-pick", ...commits], { cwd });
}

export async function revert(cwd: string, commits: string[]): Promise<void> {
  for (const commit of commits) {
    validateCommitHash(commit);
  }
  log.debug(
    `Reverting ${commits.length} commit(s): ${commits.map((c) => c.slice(0, 8)).join(", ")}`,
  );
  await runGit(["revert", "--no-commit", ...commits], { cwd });
}

export async function createBranch(cwd: string, name: string, startPoint?: string): Promise<void> {
  log.debug(`Creating branch ${name}${startPoint ? ` from ${startPoint}` : ""}`);
  validateRefName(name);
  if (startPoint) {
    validateRefName(startPoint);
    await runGit(["branch", name, startPoint], { cwd });
  } else {
    await runGit(["branch", name], { cwd });
  }
}

export async function deleteBranch(cwd: string, name: string, force = false): Promise<void> {
  log.debug(`Deleting branch ${name}${force ? " (force)" : ""}`);
  validateRefName(name);
  const flag = force ? "-D" : "-d";
  await runGit(["branch", flag, name], { cwd });
}

export async function renameBranch(cwd: string, oldName: string, newName: string): Promise<void> {
  log.debug(`Renaming branch ${oldName} to ${newName}`);
  validateRefName(oldName);
  validateRefName(newName);
  await runGit(["branch", "-m", oldName, newName], { cwd });
}

export async function stash(cwd: string, message?: string): Promise<void> {
  if (message) {
    await runGit(["stash", "push", "-m", message], { cwd });
  } else {
    await runGit(["stash", "push"], { cwd });
  }
}

export async function stashApply(cwd: string, index: number): Promise<void> {
  await runGit(["stash", "apply", `stash@{${index}}`], { cwd });
}

export async function stashPop(cwd: string, index: number): Promise<void> {
  await runGit(["stash", "pop", `stash@{${index}}`], { cwd });
}

export async function stashDrop(cwd: string, index: number): Promise<void> {
  await runGit(["stash", "drop", `stash@{${index}}`], { cwd });
}
