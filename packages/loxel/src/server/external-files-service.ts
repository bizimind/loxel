import { basename, resolve } from "node:path";

import type { DirEntry } from "@/api/project-files-model";

import type { FileChange } from "./file-sync-service";

import { FilesSyncService } from "./file-sync-service";

/**
 * Manages a set of individually-watched external files (files outside the worktree).
 * Composes with {@link FilesSyncService} for watching, debouncing, and nonce-tracked
 * writes — same pattern as DetachedFilesService.
 */
export class ExternalFilesService {
  /** Tracked file paths (source of truth for the watched set). */
  private files = new Set<string>();
  private syncService: FilesSyncService;

  constructor(
    private onListChanged: (entries: DirEntry[]) => void,
    private onFileChanged: (path: string, nonces: string[]) => void,
  ) {
    this.syncService = new FilesSyncService({
      recursive: false,
      onFlush: (changes) => this.handleFlush(changes),
    });
  }

  /** Start the underlying sync service. Must be called before watchFile/unwatchFile. */
  start(): void {
    this.syncService.start();
  }

  /** Add an external file to the watched set. */
  addFile(absolutePath: string): void {
    const normalized = resolve(absolutePath);
    if (this.files.has(normalized)) return;

    this.files.add(normalized);
    this.syncService.watchFile(normalized);
    this.onListChanged(this.listFiles());
  }

  /** Remove an external file from the watched set. */
  removeFile(absolutePath: string): void {
    const normalized = resolve(absolutePath);
    if (!this.files.has(normalized)) return;

    this.syncService.unwatchFile(normalized);
    this.files.delete(normalized);
    this.onListChanged(this.listFiles());
  }

  /** Check if a file is in the watched set. */
  hasFile(absolutePath: string): boolean {
    return this.files.has(resolve(absolutePath));
  }

  /** Write file content with nonce tracking for echo detection. */
  async writeFileContent(absolutePath: string, content: string, nonce?: string): Promise<void> {
    const normalized = resolve(absolutePath);
    if (nonce) {
      await this.syncService.writeWithNonce(normalized, nonce, () =>
        Bun.write(normalized, content).then(() => {}),
      );
    } else {
      await Bun.write(normalized, content);
    }
  }

  /** Read file content. */
  async readFileContent(absolutePath: string): Promise<string> {
    return Bun.file(resolve(absolutePath)).text();
  }

  /** List all currently watched external files as DirEntry items. */
  listFiles(): DirEntry[] {
    return [...this.files]
      .sort()
      .map((p) => ({ name: basename(p), path: p, isDir: false, status: "normal" as const }));
  }

  /** Stop all watchers and clean up. */
  stop(): void {
    this.files.clear();
    this.syncService.stop();
  }

  private handleFlush(changes: FileChange[]): void {
    for (const { key, nonces } of changes) {
      if (this.files.has(key)) {
        this.onFileChanged(key, nonces);
      }
    }
  }
}
