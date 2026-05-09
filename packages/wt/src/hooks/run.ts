import { wrapError } from "@bizimind/cli-common";

export interface HookScriptResult {
  output: string;
}

/**
 * Run a hook script with environment variables.
 * Captures stdout and stderr and returns them.
 *
 * @param script - Shell script content to execute
 * @param cwd - Working directory for the script (typically the worktree path)
 * @param env - Environment variables to set (wt-computed vars like WT_NAME, WT_PATH, etc.)
 * @param baseEnv - Base environment to merge with (default: process.env). Use to provide
 *   a resolved shell PATH when calling from a non-shell context (e.g., GUI app).
 */
export async function runHookScript(
  script: string,
  cwd: string,
  env: Record<string, string>,
  baseEnv?: Record<string, string | undefined>,
): Promise<HookScriptResult> {
  // Merge base env with hook env, allowing hook env to override
  const fullEnv = { ...(baseEnv ?? process.env), ...env };

  try {
    const proc = Bun.spawn(["bash", "-c", script], {
      cwd,
      env: fullEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    const output = (stdout + stderr).trim();

    if (exitCode !== 0) {
      throw new Error(`Script exited with code ${exitCode}${output ? `\n${output}` : ""}`);
    }

    return { output };
  } catch (err) {
    throw wrapError("Hook script failed", err);
  }
}
