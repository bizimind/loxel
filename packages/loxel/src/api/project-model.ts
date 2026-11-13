import type { Check, InitAction, InitActionId } from "@bizimind/wt/lib";
import { z } from "zod";

import type { WorktreeEntry } from "./git-models";

export const ProjectSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  addedAt: z.iso.datetime(),
  isBare: z.boolean().optional().default(false),
});

export const ProjectsDataSchema = z.object({ projects: z.array(ProjectSchema) });

export type Project = z.infer<typeof ProjectSchema>;
export type ProjectsData = z.infer<typeof ProjectsDataSchema>;

/** Response of POST /api/projects, /api/projects/clone and /api/projects/init. */
export interface ProjectSetupResult extends Project {
  /** The first worktree, when it was created without running its repository's `init.wt.sh` */
  initHookSkippedAt?: string;
  /** The `wt init` fixes that failed; the project was added anyway, set up as far as they got */
  setupFailures?: string;
}

/** Enriched project returned by GET /api/projects — includes inline worktrees + wt metadata. */
export interface EnrichedProject extends Project {
  worktrees: WorktreeEntry[];
  /** Absolute path to the repo's worktrees directory (null when not yet initialized). */
  worktreesDir: string | null;
  /** Worktree metadata (`wt init --worktree-metadata on`) is on, so worktrees can nest. */
  worktreeMetadata: boolean;
}

/** Response of GET /api/projects/:id/worktrees. */
export interface ProjectWorktreesResponse {
  worktrees: WorktreeEntry[];
  worktreeMetadata: boolean;
}

/** Response of GET /api/projects. */
export interface ProjectsResponse {
  projects: EnrichedProject[];
  /** The server user's home directory, for shortening displayed paths to `~/…`. */
  homeDir: string;
}

export interface BrowseEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

// --- Add Project Wizard types ---

export type DetectedSourceType =
  | "git-repo-bare"
  | "git-repo-regular"
  | "git-url"
  | "non-repo-folder"
  | "path-not-found"
  | "invalid";

export interface DetectPathResult {
  type: DetectedSourceType;
  path: string;
  name: string;
  branch?: string;
  hasUncommittedChanges?: boolean;
  /** For a git repository: what `wt doctor` finds and the `wt init` fixes for it */
  setup?: RepoSetupPlan;
}

/** The `wt doctor` checks of an existing repository that are not ok, and their `wt init` fixes. */
export interface RepoSetupPlan {
  checks: Check[];
  /** The fixes for `checks`, each naming the check it resolves */
  actions: InitAction[];
}

/** Body of POST /api/projects: register an existing folder, applying the chosen `wt init` fixes. */
export interface AddProjectRequest {
  path: string;
  name?: string;
  apply?: InitActionId[];
}

export interface ScanSuggestionsResult {
  files: string[];
  commands: string[];
}

export type WorkspaceSetup = "single" | "multi";

export interface CreateProjectRequest {
  name: string;
  location: string;
  setup: WorkspaceSetup;
  copyFiles?: string[];
  setupCommands?: string[];
}

export interface CloneProjectRequest {
  url: string;
  destination: string;
  setup: WorkspaceSetup;
  copyFiles?: string[];
  setupCommands?: string[];
}

export interface InitProjectRequest {
  path: string;
  name?: string;
  setup: WorkspaceSetup;
  copyFiles?: string[];
  setupCommands?: string[];
}

export interface ConvertProjectRequest {
  path: string;
  copyFiles?: string[];
  setupCommands?: string[];
}
