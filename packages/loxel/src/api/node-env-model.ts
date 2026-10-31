import type { ToolchainStatusDescriptor } from "./toolchain-status-model";

/** The version managers whose installed Node versions Loxel finds. */
export type NodeManager = "nvm" | "fnm" | "volta" | "asdf" | "mise" | "n";

/** How a worktree's Node was chosen, listed in resolution order. */
export type NodeEnvSource = "override" | "pin" | "system";

/** A Node installation Loxel found. */
export interface NodeInstall {
  /** Absolute path of the `node` executable; its directory is what goes on `PATH`. */
  nodePath: string;
  /** e.g. `22.11.0`; null when it could not be read. */
  version: string | null;
  /** The version manager that installed it; null for a `node` found only on `PATH`. */
  manager: NodeManager | null;
}

/** The Node a worktree uses. */
export interface NodeEnv extends NodeInstall {
  source: NodeEnvSource;
}

/** The version the worktree root pins. `spec` is checked against a strict grammar, so safe to show. */
export interface NodePin {
  file: string;
  spec: string;
}

/** `GET /api/node-env?wt=` response; `env` is null when no `node` was found. */
export interface NodeEnvResponse {
  env: NodeEnv | null;
  pin: NodePin | null;
  /** Why the pin could not be honored and what to run about it; null when it was, or was overridden. */
  pinProblem: string | null;
  /** The `node` chosen for the worktree, even when it is not usable and detection took over. */
  overridePath: string | null;
}

/** `GET /api/node-env/candidates?wt=` response: what the user can pick for a worktree. */
export interface NodeEnvCandidatesResponse {
  /** Newest first, then the `node` on `PATH`. */
  candidates: NodeInstall[];
  /** The `node` automatic detection would choose. */
  automaticPath: string | null;
  overridePath: string | null;
}

/** `POST /api/node-env/override` body; a null `nodePath` returns the worktree to detection. */
export interface NodeOverrideRequest {
  worktreePath: string;
  nodePath: string | null;
}

export const nodeToolchain = {
  id: "node",
  languageIds: ["javascript", "jsx", "typescript", "tsx"],
  changedMessage: "node_env_changed",
  selectAction: { id: "node.selectVersion", label: "Node: Select Version" },
} as const satisfies ToolchainStatusDescriptor;
