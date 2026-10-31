import type { ToolchainStatusDescriptor } from "./toolchain-status-model";

/** A Go version named by one of the worktree's root files. */
export interface GoProjectVersion {
  file: "go.mod" | "go.work";
  /** Without the `go` prefix, such as `1.27.3`. */
  version: string;
}

/** A worktree's Go toolchain, as `go env` reports it. */
export interface GoEnv {
  /** The `go` binary on the login-shell PATH, outside the worktree. */
  binary: string;
  /** Without the `go` prefix, such as `1.27.3`; null when this `go` did not report one. */
  version: string | null;
  goroot: string | null;
  gopath: string | null;
  gomodcache: string | null;
  /** The module file `go` uses at the worktree root; null outside any module. */
  gomod: string | null;
  /** The workspace file `go` uses at the worktree root; null outside any workspace. */
  gowork: string | null;
  goflags: string | null;
  /** The root file's `go` line, when it is newer than this Go: the project does not load. */
  newerGoNeeded: GoProjectVersion | null;
  /** The root file's `toolchain` line, when it is newer than this Go: the project still loads. */
  newerToolchainSuggested: GoProjectVersion | null;
}

export interface GoEnvResponse {
  /** Null when no usable `go` was found. */
  env: GoEnv | null;
}

/** How the status item and gopls's stopped state both describe a missing `go`. */
export const GO_NOT_FOUND = "Go is not installed or not on your PATH";

export const goToolchain = {
  id: "go",
  languageIds: ["go", "go.mod", "go.work", "go.sum"],
  changedMessage: "go_env_changed",
  selectAction: { id: "go.selectToolchain", label: "Go: Refresh Toolchain" },
} as const satisfies ToolchainStatusDescriptor;
