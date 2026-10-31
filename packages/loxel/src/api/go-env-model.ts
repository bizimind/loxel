import type { ToolchainStatusDescriptor } from "./toolchain-status-model";

/** A Go version named by one of the worktree's root files. */
export interface GoProjectVersion {
  file: "go.mod" | "go.work";
  /** Without the `go` prefix, such as `1.27.3`. */
  version: string;
}

/** Where a worktree's Go comes from. */
export type GoEnvSource =
  /** Found on the login-shell PATH. */
  | "path"
  /** The user chose it for the worktree in Loxel. */
  | "chosen"
  /** The project asks for this version, and a terminal's `go` already downloaded it. */
  | "module-cache";

/** A worktree's Go toolchain, as `go env` reports it. */
export interface GoEnv {
  /** The `go` binary, outside the worktree; for the `path` source, the one on the login-shell PATH. */
  binary: string;
  source: GoEnvSource;
  /** Without the `go` prefix, such as `1.27.3`; null when this `go` did not report one. */
  version: string | null;
  goroot: string | null;
  gopath: string | null;
  gomodcache: string | null;
  /** This Go's own `<goos>-<goarch>`, as cached toolchains name theirs. */
  toolchainPlatform: string | null;
  /** The module file `go` uses at the worktree root; null outside any module. */
  gomod: string | null;
  /** The workspace file `go` uses at the worktree root; null outside any workspace. */
  gowork: string | null;
  goflags: string | null;
  /** The user's `gopls` on that PATH, which Loxel runs; null when it runs the one it bundles. */
  gopls: string | null;
  /** The root file's `go` line, when it is newer than this Go: the project does not load. */
  newerGoNeeded: GoProjectVersion | null;
  /** The root file's `toolchain` line, when it is newer than this Go: the project still loads. */
  newerToolchainSuggested: GoProjectVersion | null;
}

export interface GoEnvResponse {
  /** Null when no usable `go` was found. */
  env: GoEnv | null;
  /** The `go` chosen for the worktree, even when it is not usable and detection took over. */
  chosen: string | null;
}

/** A Go on the machine the user can choose for a worktree. */
export interface GoToolchainChoice {
  /** The `go` binary. */
  path: string;
  version: string;
  fromModuleCache: boolean;
}

/** `GET /api/go-env/candidates?wt=` response. */
export interface GoToolchainCandidatesResponse {
  candidates: GoToolchainChoice[];
  /** What automatic detection finds. */
  automatic: GoEnv | null;
  chosen: string | null;
}

/** `POST /api/go-env/choice` body. */
export interface GoToolchainChoiceRequest {
  worktreePath: string;
  /** A `go` binary or GOROOT; null returns the worktree to automatic detection. */
  goPath: string | null;
}

/** How the status item and gopls's stopped state both describe a missing `go`. */
export const GO_NOT_FOUND = "Go is not installed or not on your PATH";

export const goToolchain = {
  id: "go",
  languageIds: ["go", "go.mod", "go.work", "go.sum"],
  changedMessage: "go_env_changed",
  selectAction: { id: "go.selectToolchain", label: "Go: Select Toolchain" },
} as const satisfies ToolchainStatusDescriptor;
