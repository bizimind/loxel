/** Where a worktree's Python interpreter was found, listed in resolution order. */
export type PythonEnvSource =
  | "override"
  | "virtual-env"
  | "conda"
  | "venv"
  | "pixi"
  | "poetry"
  | "pipenv"
  | "system";

/** The Python interpreter Loxel uses for a worktree (language server, terminals, and later tools). */
export interface PythonEnv {
  source: PythonEnvSource;
  /** Absolute path of the interpreter executable. */
  pythonPath: string;
  /** Environment prefix (the venv or conda directory); null for an interpreter outside any environment. */
  envPath: string | null;
}

/** A {@link PythonEnv} with the interpreter's version, as shown in the UI. */
export interface PythonInterpreter extends PythonEnv {
  /** Version reported by `python --version`, e.g. `3.12.13`; null when it could not be read. */
  version: string | null;
}

/** `GET /api/python-env?wt=` response; `env` is null when no interpreter was found. */
export interface PythonEnvResponse {
  env: PythonInterpreter | null;
  /** Interpreter chosen for the worktree, even when it is not usable and detection took over. */
  overridePath: string | null;
}

/** `GET /api/python-env/candidates?wt=` response: interpreters the user can pick for a worktree. */
export interface PythonEnvCandidatesResponse {
  candidates: PythonInterpreter[];
  /** Interpreter automatic detection would choose; one of the candidates. */
  automaticPath: string | null;
  /** As in {@link PythonEnvResponse}; a usable override is one of the candidates. */
  overridePath: string | null;
}

/** `POST /api/python-env/override` body; a null `pythonPath` returns the worktree to automatic detection. */
export interface PythonOverrideRequest {
  worktreePath: string;
  pythonPath: string | null;
}
