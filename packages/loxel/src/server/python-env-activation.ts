/**
 * Activating a worktree's resolved Python environment in a spawn environment through variables
 * only, what a venv's `activate` script exports. Shared by terminal shells and the built-in coding
 * agent's tool subprocesses.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import type { PythonEnv } from "@/api/python-env-model";

import { logger } from "./logger";
import { isShippedByRepo } from "./python-env";

const log = logger.child("server");

/** What activating an environment puts in a spawn environment. */
export interface PythonEnvActivation {
  /** Goes first on PATH. */
  binDir: string;
  /** The environment prefix when it is a venv (has `pyvenv.cfg`), for `VIRTUAL_ENV`; else null. */
  venvPath: string | null;
}

/**
 * How to activate `pythonEnv`, or null when it must not be: an interpreter outside any
 * environment, or a `bin` holding files git tracks in `worktreePath`.
 */
export async function pythonEnvActivation(
  pythonEnv: PythonEnv,
  worktreePath: string,
): Promise<PythonEnvActivation | null> {
  if (!pythonEnv.envPath) return null;
  const binDir = path.dirname(pythonEnv.pythonPath);
  // The whole `bin`, not just the interpreter: first on PATH, a committed `bin/git` written into
  // an ignored venv would shadow the real one.
  if (await isShippedByRepo(worktreePath, binDir)) {
    log.warn("Not activating a Python environment with files tracked by git", { binDir });
    return null;
  }
  const isVenv = existsSync(path.join(pythonEnv.envPath, "pyvenv.cfg"));
  return { binDir, venvPath: isVenv ? pythonEnv.envPath : null };
}

/**
 * Apply `activation` to `env`: its `bin` first on PATH (moved, not duplicated, when already there)
 * and no `PYTHONHOME`. `VIRTUAL_ENV` names a venv when `virtualEnv` is set, and is removed
 * otherwise.
 */
export function setPythonEnvVars(
  env: Record<string, string | undefined>,
  activation: PythonEnvActivation,
  options: { virtualEnv: boolean },
): void {
  const { binDir, venvPath } = activation;
  const rest = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir && dir !== binDir);
  env.PATH = [binDir, ...rest].join(path.delimiter);
  delete env.PYTHONHOME;
  // An environment inherited from wherever Loxel was launched no longer applies.
  delete env.VIRTUAL_ENV_PROMPT;
  if (options.virtualEnv && venvPath) env.VIRTUAL_ENV = venvPath;
  else delete env.VIRTUAL_ENV;
}
