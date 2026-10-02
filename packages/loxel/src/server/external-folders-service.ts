import { statSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { DirEntry } from "@/api/project-files-model";

import type { FileOperationsHistory } from "./file-operations-service";
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

interface ExternalFoldersServiceOptions {
  storage: ExternalFolderStorage;
  /** Why a folder cannot be opened (see `externalFolderConflict`), or null. Checked on restore. */
  conflict: (root: string) => string | null;
  history: FileOperationsHistory;
  onListChanged: () => void;
  onDirChanged: (dir: string, entries: DirEntry[]) => void;
  onFileChanged: (filePath: string, nonces: string[]) => void;
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
 * Manages the folders opened in a worktree's Others section. Each folder gets the same tree and
 * file-operation services as the worktree itself, with git disabled: the folder is not part of
 * any project, and git would otherwise act on whatever repo encloses it.
 *
 * Open folders never nest: adding a folder inside an open one is a no-op, and adding a parent of
 * open folders replaces them.
 */
export class ExternalFoldersService {
  private folders = new Map<string, ExternalFolder>();
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
      if (roots.some((kept) => root.startsWith(kept + "/"))) continue;
      if (!isDirectory(root) || this.options.conflict(root)) continue;
      roots.push(root);
    }
    await Promise.all(roots.map((root) => this.startFolder(root)));
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
    const owner = this.find(normalized);
    if (owner) return owner.root;

    for (const root of [...this.folders.keys()]) {
      if (root.startsWith(normalized + "/")) this.stopFolder(root);
    }
    await this.startFolder(normalized);
    this.persist();
    this.options.onListChanged();
    return normalized;
  }

  /** Close an open folder. Returns false when it was not open. */
  remove(path: string): boolean {
    const normalized = resolve(path);
    if (!this.folders.has(normalized)) return false;
    this.stopFolder(normalized);
    this.persist();
    this.options.onListChanged();
    return true;
  }

  /** The open folder containing `absolutePath`, the folder root itself included. */
  find(absolutePath: string): ExternalFolder | undefined {
    for (const folder of this.folders.values()) {
      if (absolutePath === folder.root || absolutePath.startsWith(folder.root + "/")) {
        return folder;
      }
    }
    return undefined;
  }

  /** Every open folder (for undo/redo bookkeeping). */
  all(): ExternalFolder[] {
    return [...this.folders.values()];
  }

  /** Open folders as tree roots, sorted by path. */
  list(): DirEntry[] {
    return [...this.folders.keys()]
      .sort()
      .map((root) => ({ name: basename(root) || root, path: root, isDir: true, status: "normal" }));
  }

  async pauseWatching(): Promise<void> {
    await Promise.all(this.all().map((folder) => folder.filesService.pauseWatching()));
  }

  async resumeWatching(): Promise<void> {
    await Promise.all(this.all().map((folder) => folder.filesService.resumeWatching()));
  }

  stop(): void {
    this.stopped = true;
    for (const root of [...this.folders.keys()]) this.stopFolder(root);
  }

  private async startFolder(root: string): Promise<void> {
    const filesService = new ProjectFilesService(
      root,
      this.options.onDirChanged,
      this.options.onFileChanged,
      undefined,
      { gitStatus: false },
    );
    const fileOpsService = new FileOperationsService(root, {
      git: false,
      history: this.options.history,
    });
    // Registered before starting so a concurrent add of the same path finds it.
    this.folders.set(root, { root, filesService, fileOpsService });
    await filesService.start();
  }

  private stopFolder(root: string): void {
    const folder = this.folders.get(root);
    if (!folder) return;
    folder.filesService.stop();
    folder.fileOpsService.dispose();
    this.folders.delete(root);
  }

  private persist(): void {
    this.options.storage.save([...this.folders.keys()].sort());
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
