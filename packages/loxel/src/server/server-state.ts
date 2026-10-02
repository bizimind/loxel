import type { LocalDb } from "@bizimind/localdb-sdk";
import type { ServerWebSocket } from "bun";

import type { DirEntry } from "@/api/project-files-model";

import type { DetachedFilesService } from "./detached-files-service";
import type { ExternalFilesService } from "./external-files-service";
import type { ExternalFolder, ExternalFoldersService } from "./external-folders-service";
import type { FileOperationsHistory, FileOperationsService } from "./file-operations-service";
import type { FileWatcher } from "./file-watcher";
import type { ProjectFilesService } from "./project-files-service";
import type { ReviewDb } from "./review-db";
import type { WorktreeStatusTracker } from "./worktree-status-tracker";

/** Lightweight, always-running state per registered project. */
export interface ProjectState {
  cwd: string;
  isBare: boolean;
  watcher: FileWatcher;
  reviewDb: ReviewDb;
  localDb: LocalDb;
  authorName: string | null;
  /** Absolute path to the directory holding this repo's worktrees (`.worktrees`). */
  worktreesDir: string;
  /** Cached dirty status of every worktree, pushed as `worktree_status_changed`. */
  worktreeStatuses: WorktreeStatusTracker;
}

/**
 * The project that owns `targetPath`: the one whose cwd or worktrees directory contains it,
 * longest matching prefix winning. The worktrees dir matters because `WT_DIR` (or a symlinked
 * `.worktrees`) can place a project's worktrees outside its cwd.
 */
export function findOwningProject<T extends Pick<ProjectState, "cwd" | "worktreesDir">>(
  projects: Iterable<T>,
  targetPath: string,
): T | undefined {
  let best: { project: T; prefix: string } | undefined;
  for (const project of projects) {
    for (const prefix of [project.cwd, project.worktreesDir]) {
      if (targetPath !== prefix && !targetPath.startsWith(prefix + "/")) continue;
      if (!best || prefix.length > best.prefix.length) best = { project, prefix };
    }
  }
  return best?.project;
}

/**
 * Why `folder` cannot be opened in an Others section, or null when it can. Folders inside a
 * project belong to its worktrees; folders containing one would watch and list it twice; the
 * filesystem root and the home folder are too large to watch recursively.
 */
export function externalFolderConflict(
  projects: readonly Pick<ProjectState, "cwd" | "worktreesDir">[],
  folder: string,
  homeDir: string,
): string | null {
  if (folder === "/" || folder === homeDir) {
    return `${folder} is too large to open; open a folder inside it`;
  }
  const owner = findOwningProject(projects, folder);
  if (owner) return `${folder} belongs to the project at ${owner.cwd}`;
  for (const project of projects) {
    if ([project.cwd, project.worktreesDir].some((p) => p.startsWith(folder + "/"))) {
      return `${folder} contains the project at ${project.cwd}`;
    }
  }
  return null;
}

/**
 * Heavy per-worktree resources, created when a client subscribes and destroyed
 * when the last subscriber disconnects. Multiple worktrees can have active
 * resources simultaneously.
 */
export interface WorktreeResources {
  /** Key into the projects map (resolved git root). */
  projectPath: string;
  /** Watches a linked worktree's git dir for status events. Null for a regular repo's root. */
  worktreeWatcher: FileWatcher | null;
  filesService: ProjectFilesService;
  fileOpsService: FileOperationsService;
  detachedFilesService: DetachedFilesService;
  externalFilesService: ExternalFilesService;
  /** Folders outside every project, opened in this worktree's Others section. */
  externalFoldersService: ExternalFoldersService;
  /** Orders file-operation undo/redo across the worktree and its Others folders. */
  fileOpsHistory: FileOperationsHistory;
  /** Connected clients subscribing to this worktree's events. */
  subscribers: Set<ServerWebSocket<WsData>>;
}

/** A worktree's Others section: its open folders, then its open external files. */
export function listOthers(resources: WorktreeResources): DirEntry[] {
  return [
    ...resources.externalFoldersService.list(),
    ...resources.externalFilesService.listFiles(),
  ];
}

/** Result of resolving an absolute file path to its owning worktree + service. */
export type ResolvedFilePath =
  | { type: "project"; wtPath: string; resources: WorktreeResources; relativePath: string }
  | { type: "detached"; wtPath: string; resources: WorktreeResources; name: string }
  | { type: "external"; wtPath: string; resources: WorktreeResources; absolutePath: string }
  | {
      type: "external-folder";
      wtPath: string;
      resources: WorktreeResources;
      folder: ExternalFolder;
      /** Relative to the folder root; empty for the root itself. */
      relativePath: string;
    };

/** Per-client tracking for cleanup on disconnect. */
export interface ClientState {
  terminals: Set<string>;
  subscribedWorktrees: Set<string>;
}

/** WS data tag for routing app vs language-server connections. */
export type WsData =
  | { type: "app" }
  | { type: "yaml-lsp" }
  | WorktreeLspData<"ts-lsp">
  | WorktreeLspData<"docker-lsp">
  | WorktreeLspData<"terraform-lsp">
  | WorktreeLspData<"python-lsp">
  | WorktreeLspData<"astro-lsp">
  | WorktreeLspData<"xml-lsp">;

export type WorktreeLspData<T extends string = string> = { type: T; wtPath: string };
export type WorktreeLspType = Extract<WsData, { wtPath: string }>["type"];
