import { isAbsolute } from "node:path";

import { gitSucceeds } from "./run.ts";

/**
 * Why `name` is unusable as a worktree name, or null if it is fine.
 *
 * A worktree name doubles as a branch name and as a path under the worktrees
 * directory, so it has to satisfy both: no escaping the worktrees directory,
 * and a valid git ref. Nested names like `feat/foo` are allowed.
 */
export async function worktreeNameError(name: string, cwd?: string): Promise<string | null> {
  const structural = structuralNameError(name);
  if (structural) return structural;

  if (!(await gitSucceeds(["check-ref-format", `refs/heads/${name}`], cwd))) {
    return `'${name}' is not a valid git branch name`;
  }
  return null;
}

/** The path-shape half of the check: synchronous, no git involved. */
export function structuralNameError(name: string): string | null {
  if (!name) return "name must not be empty";
  if (name.startsWith("-")) return "name must not start with '-'";
  if (isAbsolute(name)) return "name must be relative to the worktrees directory";

  const segments = name.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "name must not contain empty, '.' or '..' path segments";
  }
  return null;
}

/** Throw if `name` is unusable as a worktree name. */
export async function assertValidWorktreeName(name: string): Promise<void> {
  const error = await worktreeNameError(name);
  if (error) throw new Error(error);
}
