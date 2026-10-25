/** Where a worktree's Python interpreter was found, listed in resolution order. */
export type PythonEnvSource = "override" | "virtual-env" | "venv" | "pixi" | "poetry" | "system";

/** The Python interpreter Loxel uses for a worktree (language server, terminals, and later tools). */
export interface PythonEnv {
  source: PythonEnvSource;
  /** Absolute path of the interpreter executable. */
  pythonPath: string;
  /** Environment prefix (the venv or conda directory); null for an interpreter outside any environment. */
  envPath: string | null;
}

/** `GET /api/python-env?wt=` response; `env` is null when no interpreter was found. */
export interface PythonEnvResponse {
  env: PythonEnv | null;
}
