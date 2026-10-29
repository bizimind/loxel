import { listManagedWorktrees } from "../lib/index.ts";
import { isTTY, pickWorktree } from "../prompt.ts";

/**
 * The worktree name to act on: the one given, or one picked from a list.
 *
 * @param action - Verb used in prompts and error messages ("view", "remove")
 * @param usage - Usage line for the non-interactive error (default: `wt <action> <name>`)
 */
export async function resolveWorktreeName(
  name: string | undefined,
  action: string,
  repoPath: string,
  usage = `wt ${action} <name>`,
): Promise<string> {
  if (name) return name;

  const managed = await listManagedWorktrees(repoPath);
  if (managed.length === 0) {
    throw new Error(`No worktrees to ${action}.\n\nCreate one with: wt add <name>`);
  }
  // Unattended callers must name the target explicitly: auto-picking the sole
  // worktree would let a bare `wt remove` in a script delete it.
  if (!isTTY()) {
    throw new Error(`Worktree name required in non-interactive mode.\n\nUsage: ${usage}`);
  }
  if (managed.length === 1 && managed[0]) return managed[0].name;

  return pickWorktree(
    `Select a worktree to ${action}:`,
    managed.map((wt) => ({
      name: wt.branch && wt.branch !== wt.name ? `${wt.name} (${wt.branch})` : wt.name,
      value: wt.name,
    })),
  );
}
