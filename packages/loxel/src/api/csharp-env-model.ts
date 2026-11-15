import type { ToolchainStatusDescriptor } from "./toolchain-status-model";

/** One `sdk.paths` entry of a `global.json`, as read from the file; nothing is run to find this. */
export interface GlobalJsonSdkPath {
  /** The entry as written, e.g. `.dotnet` or `$host$`. */
  entry: string;
  /** Absolute path; null for `$host$` when no `dotnet` was found. */
  path: string | null;
  /** The path lies inside the worktree. */
  insideWorktree: boolean;
  /** Git tracks something there (see `isShippedByRepo` in `shipped-by-repo.ts`). */
  tracked: boolean;
}

/** The `global.json` that applies to a directory. */
export interface GlobalJsonInfo {
  /** Absolute path of the file. */
  path: string;
  /** False when the file could not be read unambiguously; the other fields are then empty. */
  valid: boolean;
  /** `sdk.version`. */
  sdkVersion: string | null;
  /** `sdk.rollForward`. */
  rollForward: string | null;
  /** `sdk.paths`; null when the file does not set it. */
  sdkPaths: GlobalJsonSdkPath[] | null;
}

/** One `Microsoft.NETCore.App` runtime. */
export interface DotnetRuntime {
  /** e.g. `10.0.14`. */
  version: string;
  /** The .NET install holding it, usable as `DOTNET_ROOT`. */
  root: string;
}

/** The `Microsoft.NETCore.App` runtimes of the `dotnet` on `PATH` and under `DOTNET_ROOT`. */
export interface DotnetRuntimes {
  runtimes: DotnetRuntime[];
  /** An install with a runtime of major 10 or above, `DOTNET_ROOT`'s first; null when none has one. */
  runtime10Root: string | null;
}

/** What to load for a worktree when nothing was chosen. */
export type CSharpLoadTarget =
  | { kind: "solution"; path: string }
  | { kind: "projects"; paths: string[] };

/** The C# solutions and projects in a worktree, as absolute sorted paths. */
export interface CSharpProjects {
  /** `.sln` and `.slnx` files. */
  solutions: string[];
  /** `.slnf` files. */
  solutionFilters: string[];
  /** `.csproj` files. */
  projects: string[];
  /** The only root solution, otherwise every project; null with no solution or project at all. */
  defaultTarget: CSharpLoadTarget | null;
}

/** Whether a project's dependencies have been restored. */
export interface CSharpRestoreState {
  /** Absolute path of the `.csproj`. */
  project: string;
  restored: boolean;
  /** Where `project.assets.json` belongs; null when the layout cannot be determined from files. */
  assetsPath: string | null;
}

/** Why csharp-ls does not run for a worktree, or (`load-failed`) runs with nothing loaded. */
export type CSharpBlock =
  | "untrusted"
  | "no-dotnet"
  | "no-csharp-ls"
  | "old-csharp-ls"
  | "csharp-ls-failed"
  | "not-restored"
  | "load-failed";

/** What the language server manager last decided for a worktree. */
export type CSharpLspState =
  | { kind: "no-project" }
  /** A server ended and nothing has been decided since. */
  | { kind: "stopped" }
  | {
      kind: "running";
      /** The solution or solution filter it was told to load; null when it loads the projects. */
      target: string | null;
      /** The projects that load, as absolute paths. */
      projects: string[];
      sdkVersion: string;
    }
  | {
      kind: "blocked";
      block: CSharpBlock;
      /** What to do about it, the words the user gets as a notice. */
      message: string;
    };

/** `GET /api/csharp-status?wt=` response. */
export interface CSharpStatusResponse {
  /** Null until a connection for the worktree has been decided on. */
  server: CSharpLspState | null;
  /** The solution chosen for the worktree, even when it is gone and detection took over. */
  chosen: string | null;
  /** The chosen solution is no longer among the worktree's solutions. */
  chosenMissing: boolean;
}

/** `GET /api/csharp-status/solutions?wt=` response: what the user can choose for a worktree. */
export interface CSharpSolutionsResponse {
  /** `.sln`, `.slnx` and `.slnf` files, which are what csharp-ls's `--solution` loads. */
  solutions: string[];
  /** What automatic detection loads; null when that is every project. */
  automatic: string | null;
  chosen: string | null;
  /** Nothing loads, whatever is chosen, until the repository is trusted. */
  trusted: boolean;
}

/** `POST /api/csharp-status/solution` body; a null `solutionPath` returns to automatic detection. */
export interface CSharpSolutionRequest {
  worktreePath: string;
  solutionPath: string | null;
}

export const csharpToolchain = {
  id: "csharp",
  languageIds: ["csharp"],
  changedMessage: "csharp_status_changed",
  selectAction: { id: "csharp.selectSolution", label: "C#: Select Solution" },
} as const satisfies ToolchainStatusDescriptor;
