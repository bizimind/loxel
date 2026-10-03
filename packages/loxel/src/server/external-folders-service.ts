import { statSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { DirEntry } from "@/api/project-files-model";
import { findTreeRoot, isWithin } from "@/lib/project-file-helpers";

import { FileOperationsService } from "./file-operations-service";
import { logger } from "./logger";
import { ProjectFilesService } from "./project-files-service";
import { getStore, putStore } from "./store-db";

const log = logger.child("files");

/**
 * A tree the files panel browses — a worktree's own, or a folder in its Others section: the root
 * every relative path resolves against, and the services that list and modify it.
 */
export interface FileTree {
  root: string;
  filesService: ProjectFilesService;
  fileOpsService: FileOperationsService;
}

/** A folder outside every project, shown in a worktree's Others section. */
export type ExternalFolder = FileTree;

/** Where a worktree's list of open folders is persisted. */
export interface ExternalFolderStorage {
  load: () => string[];
  save: (roots: string[]) => void;
}

/** Where a folder's change events go: the worktrees that currently have it open. */
interface ExternalFolderEvents {
  onDirChanged: (worktrees: readonly string[], dir: string, entries: DirEntry[]) => void;
  onFileChanged: (worktrees: readonly string[], filePath: string, nonces: string[]) => void;
}

interface SharedFolder {
  folder: ExternalFolder;
  /** Worktrees (with live resources) whose Others section lists the folder. */
  worktrees: Set<string>;
  started: Promise<void>;
}

/**
 * The folders open in any worktree's Others section, shared server-wide: each folder has one
 * watcher, directory cache and set of services however many worktrees list it, and its changes
 * reach every one of them. A folder is live while a subscribed worktree lists it.
 *
 * Its services are the worktree tree's, with git disabled: the folder is not part of any project,
 * and git would otherwise act on whatever repo encloses it.
 */
export class ExternalFolderRegistry {
  private folders = new Map<string, SharedFolder>();

  constructor(private events: ExternalFolderEvents) {}

  /** Start using `root` from `wtPath`, starting its services if no worktree uses it yet. */
  async acquire(root: string, wtPath: string): Promise<ExternalFolder> {
    let shared = this.folders.get(root);
    if (!shared) {
      const users = new Set<string>();
      const filesService = new ProjectFilesService(
        root,
        (dir, entries) => this.events.onDirChanged([...users], dir, entries),
        (filePath, nonces) => this.events.onFileChanged([...users], filePath, nonces),
        undefined,
        { gitStatus: false },
      );
      const fileOpsService = new FileOperationsService(root, { git: false });
      shared = {
        folder: { root, filesService, fileOpsService },
        worktrees: users,
        started: filesService.start(),
      };
      // Registered before starting so a concurrent acquire of the same root shares it.
      this.folders.set(root, shared);
    }
    shared.worktrees.add(wtPath);
    await shared.started;
    return shared.folder;
  }

  /** Stop using `root` from `wtPath`; its services stop when no worktree uses it any more. */
  release(root: string, wtPath: string): void {
    const shared = this.folders.get(root);
    if (!shared) return;
    shared.worktrees.delete(wtPath);
    if (shared.worktrees.size > 0) return;
    shared.folder.filesService.stop();
    shared.folder.fileOpsService.dispose();
    this.folders.delete(root);
  }

  get(root: string): ExternalFolder | undefined {
    return this.folders.get(root)?.folder;
  }
}

interface ExternalFoldersServiceOptions {
  wtPath: string;
  registry: ExternalFolderRegistry;
  storage: ExternalFolderStorage;
  /** Why a folder cannot be opened (see `externalFolderConflict`), or null. Checked on restore. */
  conflict: (root: string) => string | null;
  onListChanged: () => void;
}

/** Store-database key holding a worktree's open folders. */
export function externalFoldersStoreKey(wtPath: string): string {
  return `external-folders:${wtPath}`;
}

/** Persist a worktree's open folders in the server's store database. */
export function createExternalFolderStorage(wtPath: string): ExternalFolderStorage {
  const key = externalFoldersStoreKey(wtPath);
  return {
    load: () => {
      const raw = getStore(key);
      if (!raw) return [];
      try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
      } catch (err) {
        log.warn("Ignoring unreadable external folder list", { wtPath, error: err });
        return [];
      }
    },
    save: (roots) => putStore(key, JSON.stringify(roots)),
  };
}

/**
 * The folders listed in one worktree's Others section, persisted per worktree. The folders
 * themselves are shared through {@link ExternalFolderRegistry}.
 *
 * Open folders never nest: adding a folder inside an open one is a no-op, and adding a parent of
 * open folders replaces them.
 */
export class ExternalFoldersService {
  private roots = new Set<string>();
  private stopped = false;

  constructor(private options: ExternalFoldersServiceOptions) {}

  /**
   * Restore the persisted folders, dropping those that no longer exist or can no longer be opened
   * (e.g. they became part of a project since), and any nested in another.
   */
  async start(): Promise<void> {
    const stored = this.options.storage.load();
    const roots: string[] = [];
    for (const root of [...stored].sort()) {
      if (findTreeRoot(root, roots)) continue;
      if (!isDirectory(root) || this.options.conflict(root)) continue;
      roots.push(root);
    }
    await Promise.all(roots.map((root) => this.open(root)));
    if (roots.length !== stored.length) this.persist();
  }

  /**
   * Open a folder and return the root it is shown under: the folder itself, or the already-open
   * folder that contains it.
   */
  async add(path: string): Promise<string> {
    // The worktree may have been torn down while the caller awaited.
    if (this.stopped) throw new Error("Worktree is no longer active");
    const normalized = resolve(path);
    const owner = findTreeRoot(normalized, this.roots);
    if (owner) return owner;

    for (const root of [...this.roots]) {
      if (isWithin(root, normalized)) this.close(root);
    }
    await this.open(normalized);
    this.persist();
    this.options.onListChanged();
    return normalized;
  }

  /** Close an open folder. Returns false when it was not open. */
  remove(path: string): boolean {
    const normalized = resolve(path);
    if (!this.roots.has(normalized)) return false;
    this.close(normalized);
    this.persist();
    this.options.onListChanged();
    return true;
  }

  /** The open folder containing `absolutePath`, the folder root itself included. */
  find(absolutePath: string): ExternalFolder | undefined {
    const root = findTreeRoot(absolutePath, this.roots);
    return root ? this.options.registry.get(root) : undefined;
  }

  /** Every open folder (for undo/redo bookkeeping). */
  all(): ExternalFolder[] {
    return [...this.roots].flatMap((root) => this.options.registry.get(root) ?? []);
  }

  /** Open folders as tree roots, sorted by path. */
  list(): DirEntry[] {
    return [...this.roots]
      .sort()
      .map((root) => ({ name: basename(root) || root, path: root, isDir: true, status: "normal" }));
  }

  /** Release every folder (worktree teardown); the persisted list is kept. */
  stop(): void {
    this.stopped = true;
    for (const root of [...this.roots]) this.close(root);
  }

  private async open(root: string): Promise<void> {
    this.roots.add(root);
    await this.options.registry.acquire(root, this.options.wtPath);
  }

  private close(root: string): void {
    this.roots.delete(root);
    this.options.registry.release(root, this.options.wtPath);
  }

  private persist(): void {
    this.options.storage.save([...this.roots].sort());
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
