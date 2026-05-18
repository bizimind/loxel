import { resolveConfig, getWorktreesDir } from "../config/loader.ts";
import type { WtConfig } from "../config/schema.ts";
import { isTTY } from "../init/detect.ts";
import { search } from "../prompt.ts";
import { listWorktrees, findWorktreeByName, type Worktree } from "./git.ts";

/**
 * Get managed worktrees (non-bare, under worktrees directory).
 * Excludes nested worktrees created by tools like Claude Code (.claude/worktrees/).
 */
export function getManagedWorktrees(worktrees: Worktree[], worktreesDir: string): Worktree[] {
  const base = worktreesDir.endsWith("/") ? worktreesDir : worktreesDir + "/";
  return worktrees.filter((wt) => {
    if (wt.bare || !wt.path.startsWith(worktreesDir)) return false;
    // Exclude nested worktrees (e.g., .worktrees/foo/.claude/worktrees/agent-xyz)
    const relativePath = wt.path.slice(base.length);
    return !relativePath.includes("/.claude/");
  });
}

/**
 * Extract worktree name from its path, relative to the worktrees directory.
 * Handles names with slashes like "feat/add-voice-input".
 */
export function getWorktreeName(wtPath: string, worktreesDir: string): string {
  // Remove trailing slash from worktreesDir if present
  const baseDir = worktreesDir.endsWith("/") ? worktreesDir : worktreesDir + "/";
  if (wtPath.startsWith(baseDir)) {
    return wtPath.slice(baseDir.length);
  }
  // Fallback to last path segment
  return wtPath.split("/").pop() ?? wtPath;
}

export interface WorktreeSelectionContext {
  config: WtConfig;
  rootDir: string;
  worktreesDir: string;
  worktrees: Worktree[];
  managed: Worktree[];
}

/**
 * Load worktree context for commands that operate on worktrees.
 *
 * @param options.repoPath - Explicit repo path, or undefined to walk up from cwd
 */
export async function loadWorktreeContext(options?: {
  repoPath?: string;
}): Promise<WorktreeSelectionContext> {
  const { config, rootDir } = await resolveConfig(options?.repoPath);
  const worktreesDir = getWorktreesDir({ config, rootDir, configPath: "" });
  const worktrees = await listWorktrees(rootDir);
  const managed = getManagedWorktrees(worktrees, worktreesDir);

  return { config, rootDir, worktreesDir, worktrees, managed };
}

export interface SelectWorktreeOptions {
  /** Prompt message for interactive selection */
  promptMessage: string;
  /** Error message prefix for non-interactive mode */
  nonInteractiveUsage: string;
  /** Error message when no worktrees exist */
  noWorktreesMessage?: string;
}

/**
 * Select a worktree by name or interactively.
 * Returns the selected worktree and its name.
 */
export async function selectWorktree(
  ctx: WorktreeSelectionContext,
  name: string | undefined,
  options: SelectWorktreeOptions,
): Promise<{ worktree: Worktree; name: string }> {
  let selectedName = name;

  if (!selectedName) {
    if (!isTTY()) {
      throw new Error(
        `Worktree name required in non-interactive mode.\n\n${options.nonInteractiveUsage}`,
      );
    }

    if (ctx.managed.length === 0) {
      throw new Error(
        options.noWorktreesMessage ?? "No worktrees exist yet.\n\nCreate one with: wt add <name>",
      );
    }

    const choices = ctx.managed.map((wt) => {
      const wtName = getWorktreeName(wt.path, ctx.worktreesDir);
      return { name: `${wtName}${wt.branch ? ` (${wt.branch})` : ""}`, value: wtName };
    });

    selectedName = await search({
      message: options.promptMessage,
      source: (term) => {
        if (!term) return choices;
        const lower = term.toLowerCase();
        return choices.filter((c) => c.name.toLowerCase().includes(lower));
      },
    });
  }

  const worktree = findWorktreeByName(ctx.worktrees, selectedName);

  if (!worktree) {
    throwWorktreeNotFound(selectedName, ctx.managed, ctx.worktreesDir);
  }

  return { worktree, name: selectedName };
}

/**
 * Throw a formatted "worktree not found" error.
 */
function throwWorktreeNotFound(name: string, managed: Worktree[], worktreesDir: string): never {
  const managedNames = managed.map((wt) => getWorktreeName(wt.path, worktreesDir));

  if (managedNames.length > 0) {
    throw new Error(
      `Worktree '${name}' not found.\n\nAvailable worktrees:\n  ${managedNames.join("\n  ")}`,
    );
  }
  throw new Error(
    `Worktree '${name}' not found. No worktrees exist yet.\n\nCreate one with: wt add <name>`,
  );
}
