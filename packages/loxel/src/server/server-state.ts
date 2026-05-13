import type { LocalDb } from "@bizimind/localdb-sdk";
import type { ServerWebSocket } from "bun";

import type { DetachedFilesService } from "./detached-files-service";
import type { ExternalFilesService } from "./external-files-service";
import type { FileOperationsService } from "./file-operations-service";
import type { FileWatcher } from "./file-watcher";
import type { ProjectFilesService } from "./project-files-service";
import type { ReviewDb } from "./review-db";

/** Lightweight, always-running state per registered project. */
export interface ProjectState {
  cwd: string;
  isBare: boolean;
  watcher: FileWatcher;
  reviewDb: ReviewDb;
  localDb: LocalDb;
  authorName: string | null;
  hasWtConfig: boolean;
  wtCliAvailable: boolean;
  /** Absolute path to the worktrees directory from wt.yaml (null when hasWtConfig is false). */
  worktreesDir: string | null;
}

/**
 * Heavy per-worktree resources, created when a client subscribes and destroyed
 * when the last subscriber disconnects. Multiple worktrees can have active
 * resources simultaneously.
 */
export interface WorktreeResources {
  /** Key into the projects map (resolved git root). */
  projectPath: string;
  /** Watches the worktree's .git dir for status events. Null for non-bare repos. */
  worktreeWatcher: FileWatcher | null;
  filesService: ProjectFilesService;
  fileOpsService: FileOperationsService;
  detachedFilesService: DetachedFilesService;
  externalFilesService: ExternalFilesService;
  /** Connected clients subscribing to this worktree's events. */
  subscribers: Set<ServerWebSocket<WsData>>;
  /** Per-worktree git status suppress timer to prevent retrigger loops. */
  statusSuppressUntil: number;
}

/** Result of resolving an absolute file path to its owning worktree + service. */
export type ResolvedFilePath =
  | { type: "project"; wtPath: string; resources: WorktreeResources; relativePath: string }
  | { type: "detached"; wtPath: string; resources: WorktreeResources; name: string }
  | { type: "external"; wtPath: string; resources: WorktreeResources; absolutePath: string };

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
