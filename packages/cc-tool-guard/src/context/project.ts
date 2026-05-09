import type { ProjectContext } from "../types.ts";

/**
 * Get project context including git information
 */
export async function getProjectContext(cwd: string): Promise<ProjectContext> {
  // Find git root
  const gitRootResult = await Bun.$`git -C ${cwd} rev-parse --show-toplevel`.quiet().nothrow();
  const isGitRepo = gitRootResult.exitCode === 0;
  const projectRoot = isGitRepo ? gitRootResult.stdout.toString().trim() : cwd;

  // Get current branch
  let currentBranch = "";
  if (isGitRepo) {
    const branchResult = await Bun.$`git -C ${cwd} branch --show-current`.quiet().nothrow();
    currentBranch = branchResult.exitCode === 0 ? branchResult.stdout.toString().trim() : "";
  }

  return { projectRoot, currentBranch, cwd, isGitRepo };
}
