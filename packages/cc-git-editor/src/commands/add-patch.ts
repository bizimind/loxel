/**
 * Handle git add -p in agent mode
 *
 * Copies changed files to a staging directory where the agent can edit them
 * to show exactly what they want staged.
 */

import { mkdir, copyFile, rm } from "fs/promises";
import { dirname, join } from "path";

import { getGitDir, runGit } from "../utils/git.ts";

const STAGED_DIR_NAME = ".cc-git-editor/staged";

/**
 * Handle git add -p in agent mode.
 *
 * Copies changed files to .git/.cc-git-editor/staged/ for editing.
 */
export async function handleAddPatch(_args: string[]): Promise<void> {
  const gitDir = await getGitDir();
  const stagedDir = join(gitDir, STAGED_DIR_NAME);

  // Clean previous state
  await rm(stagedDir, { recursive: true, force: true });

  // Get list of changed files (unstaged)
  const result = await runGit(["diff", "--name-only"]);
  const files = result.stdout.trim().split("\n").filter(Boolean);

  if (files.length === 0) {
    console.log("No unstaged changes to add.");
    process.exit(0);
  }

  // Copy each changed file
  await Promise.all(
    files.map(async (file) => {
      const destDir = join(stagedDir, dirname(file));
      await mkdir(destDir, { recursive: true });
      await copyFile(file, join(stagedDir, file));
    }),
  );

  console.log("Agentic staging mode.");
  console.log("");
  console.log(`Files copied to: ${stagedDir}/`);
  for (const file of files) {
    console.log(`  ${file}`);
  }
  console.log("");
  console.log("Edit files to show exactly what you want staged.");
  console.log("Remove changes you don't want committed, keep changes you do.");
  console.log("");
  console.log("When ready, run: apply-staged-edits");
  console.log(`To cancel, run: rm -rf ${stagedDir}`);

  process.exit(0);
}
