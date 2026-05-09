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

/** Enriched project returned by GET /api/projects — includes inline worktrees + wt metadata. */
export interface EnrichedProject extends Project {
  worktrees: WorktreeEntry[];
  hasWtConfig: boolean;
  wtCliAvailable: boolean;
  worktreesDir: string | null;
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
  hasWtConfig?: boolean;
  hasUncommittedChanges?: boolean;
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
