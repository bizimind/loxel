import { DETACHED } from "../git/index.ts";
import { silentProgress, type ProgressHandler } from "../progress.ts";

/** Run inside a new worktree right after `wt add`. */
export const HOOK_INIT = "init.wt.sh";
/** Run inside a worktree right before `wt remove`. */
export const HOOK_CLEAN = "clean.wt.sh";
/** Run inside a worktree at its new path right after `wt mv`. */
export const HOOK_RENAME = "rename.wt.sh";

export interface HookContext {
  /** Repository root — where hook scripts live */
  root: string;
  /** Worktree name */
  name: string;
  /** Absolute path to the worktree the hook runs in */
  worktreePath: string;
  /** Branch name, or null when detached */
  branch: string | null;
  /** Base environment for the hook (default: process.env) */
  baseEnv?: Record<string, string | undefined>;
  /** Hook-specific variables layered on top of the standard WT_* set */
  extraEnv?: Record<string, string>;
}

/**
 * Run a repo-root hook script if it exists, with cwd set to the worktree.
 *
 * A hook that is missing, or that fails, never aborts the surrounding
 * add/remove: failures are reported through `progress.warn`.
 *
 * @returns true when the script existed and exited 0
 */
export async function runHook(
  hook: string,
  ctx: HookContext,
  progress: ProgressHandler = silentProgress,
): Promise<boolean> {
  const script = `${ctx.root}/${hook}`;
  if (!(await Bun.file(script).exists())) return false;

  progress.log(`Running ${hook}...`);

  const proc = Bun.spawn(["bash", script], {
    cwd: ctx.worktreePath,
    env: {
      ...(ctx.baseEnv ?? process.env),
      WT_NAME: ctx.name,
      WT_PATH: ctx.worktreePath,
      WT_ROOT: ctx.root,
      WT_BRANCH: ctx.branch ?? DETACHED,
      ...ctx.extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const output = (stdout + stderr).trim();
  if (output) progress.log(output);

  if (exitCode !== 0) {
    progress.warn(`Warning: ${hook} exited with code ${exitCode}; continuing`);
    return false;
  }
  return true;
}
