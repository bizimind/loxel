#!/usr/bin/env bun
/**
 * Apply staged edits to the git index
 *
 * Stages the exact content of files in .git/.cc-git-editor/staged/
 * using git hash-object and update-index.
 */

import { rm } from "fs/promises";
import { join } from "path";

import { Glob } from "bun";

import { getGitDir, runGit } from "../utils/git.ts";

const STAGED_DIR_NAME = ".cc-git-editor/staged";

async function main() {
  const gitDir = await getGitDir();
  const stagedDir = join(gitDir, STAGED_DIR_NAME);

  await verifyStagedDirExists(stagedDir);
  const files = await collectStagedFiles(stagedDir);

  if (files.length === 0) {
    console.log("No files to stage.");
    await rm(stagedDir, { recursive: true, force: true });
    process.exit(0);
  }

  await stageFiles(files, stagedDir);
  await cleanup(stagedDir);
}

async function verifyStagedDirExists(stagedDir: string): Promise<void> {
  try {
    const stat = await Bun.$`test -d ${stagedDir}`.quiet().nothrow();
    if (stat.exitCode !== 0) {
      console.error(`ERROR: No staged directory found at ${stagedDir}`);
      console.error("Run 'git add -p' first to set up staging.");
      process.exit(1);
    }
  } catch {
    console.error(`ERROR: No staged directory found at ${stagedDir}`);
    process.exit(1);
  }
}

async function collectStagedFiles(stagedDir: string): Promise<string[]> {
  const glob = new Glob("**/*");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: stagedDir, onlyFiles: true })) {
    files.push(file);
  }
  return files;
}

async function stageFiles(files: string[], stagedDir: string): Promise<void> {
  await Promise.all(
    files.map(async (relPath) => {
      const stagedFile = join(stagedDir, relPath);
      const hashResult = await Bun.$`git hash-object -w ${stagedFile}`.quiet();
      const hash = hashResult.stdout.toString().trim();
      await Bun.$`git update-index --add --cacheinfo 100644,${hash},${relPath}`.quiet();
      console.log(`Staged: ${relPath}`);
    }),
  );
  console.log("");
  console.log(`Staged ${files.length} file(s).`);
}

async function cleanup(stagedDir: string): Promise<void> {
  await rm(stagedDir, { recursive: true, force: true });
  const statusResult = await runGit(["status", "--short"]);
  console.log("");
  console.log(statusResult.stdout);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
