import { constants, copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DirEntry } from "@/api/project-files-model";

import type { FileChange } from "./file-sync-service";

import { FilesSyncService } from "./file-sync-service";
import { logger } from "./logger";

const log = logger.child("detached");

/**
 * Manages a flat directory of detached files (drafts) scoped to a project+worktree.
 * Provides CRUD operations, file watching, and sequential naming.
 *
 * Composes with {@link FilesSyncService} for fs.watch lifecycle, debouncing,
 * and nonce-tracked writes.
 */
export class DetachedFilesService {
  private syncService: FilesSyncService;
  private cachedEntries: DirEntry[] = [];

  constructor(
    readonly dir: string,
    private onListChanged: (entries: DirEntry[]) => void,
    private onFileChanged?: (path: string, nonces: string[]) => void,
  ) {
    this.syncService = new FilesSyncService({
      watchDir: dir,
      recursive: false,
      filter: (filename) => !filename.startsWith("."),
      onFlush: (changes) => this.handleFlush(changes),
    });
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.cachedEntries = await this.readDir();
    this.syncService.start();
  }

  stop(): void {
    this.syncService.stop();
    this.cachedEntries = [];
  }

  listFiles(): DirEntry[] {
    return this.cachedEntries;
  }

  /**
   * Compute next sequential filename: "Note 1.md", "Note 2.md", etc.
   * Scans existing files and picks the first unused number.
   * When `ext` is omitted, produces extensionless names: "Untitled 1", "Untitled 2".
   */
  getNextFilename(prefix: string, ext?: string): string {
    const existingNumbers = new Set<number>();
    const suffix = ext ? `\\.${escapeRegExp(ext)}` : "";
    const pattern = new RegExp(`^${escapeRegExp(prefix)} (\\d+)${suffix}$`);
    for (const entry of this.cachedEntries) {
      const match = entry.name.match(pattern);
      if (match) existingNumbers.add(parseInt(match[1]!, 10));
    }
    let n = 1;
    while (existingNumbers.has(n)) n++;
    return ext ? `${prefix} ${n}.${ext}` : `${prefix} ${n}`;
  }

  /**
   * Create a new detached file with a sequential name.
   * Uses O_CREAT|O_EXCL (wx flag) for atomic creation — retries with next
   * available number on EEXIST to handle concurrent requests safely.
   */
  async createFile(prefix: string, ext?: string, content?: string): Promise<string> {
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const name = this.getNextFilename(prefix, ext);
      try {
        await writeFile(join(this.dir, name), content ?? "", { flag: "wx" });
        this.cachedEntries = await this.readDir();
        this.onListChanged(this.cachedEntries);
        return name;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          // Another concurrent request grabbed this name — refresh cache and retry
          this.cachedEntries = await this.readDir();
          continue;
        }
        throw err;
      }
    }
    // Fallback: should not normally reach here
    const name = this.getNextFilename(prefix, ext);
    await Bun.write(join(this.dir, name), content ?? "");
    this.cachedEntries = await this.readDir();
    this.onListChanged(this.cachedEntries);
    return name;
  }

  async readFileContent(name: string): Promise<string> {
    return Bun.file(join(this.dir, name)).text();
  }

  /** Write file content, optionally with nonce tracking for echo detection. */
  async writeFileContent(name: string, content: string, nonce?: string): Promise<void> {
    if (nonce) {
      await this.syncService.writeWithNonce(name, nonce, () =>
        Bun.write(join(this.dir, name), content).then(() => {}),
      );
    } else {
      await Bun.write(join(this.dir, name), content);
    }
  }

  async renameFile(oldName: string, newName: string): Promise<void> {
    const src = join(this.dir, oldName);
    const dest = join(this.dir, newName);
    // Prevent overwriting an existing file
    const exists = await stat(dest).then(
      () => true,
      () => false,
    );
    if (exists) throw new Error(`File already exists: ${newName}`);
    await rename(src, dest);
    this.cachedEntries = await this.readDir();
    this.onListChanged(this.cachedEntries);
  }

  async deleteFile(name: string): Promise<void> {
    await rm(join(this.dir, name), { force: true });
    this.cachedEntries = await this.readDir();
    this.onListChanged(this.cachedEntries);
  }

  /**
   * Copy a detached file into the project tree (preserving the draft).
   * Returns the absolute path of the new file.
   */
  async copyToProject(name: string, destDir: string, worktreeCwd: string): Promise<string> {
    const src = join(this.dir, name);
    const targetDir = destDir ? join(worktreeCwd, destDir) : worktreeCwd;
    await mkdir(targetDir, { recursive: true });
    const dest = join(targetDir, name);
    await copyFile(src, dest, constants.COPYFILE_EXCL);
    return dest;
  }

  /**
   * Move a detached file into the project tree.
   * Returns the absolute path of the new file.
   */
  async moveToProject(name: string, destDir: string, worktreeCwd: string): Promise<string> {
    const src = join(this.dir, name);
    const targetDir = destDir ? join(worktreeCwd, destDir) : worktreeCwd;
    await mkdir(targetDir, { recursive: true });
    const dest = join(targetDir, name);
    // Prevent silently overwriting existing project files
    const exists = await stat(dest).then(
      () => true,
      () => false,
    );
    if (exists) throw new Error(`File already exists: ${destDir ? `${destDir}/${name}` : name}`);
    try {
      await rename(src, dest);
    } catch (err: unknown) {
      // rename() fails across filesystem boundaries (EXDEV) — fall back to copy+delete
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        await copyFile(src, dest, constants.COPYFILE_EXCL);
        await rm(src);
      } else {
        throw err;
      }
    }
    this.cachedEntries = await this.readDir();
    this.onListChanged(this.cachedEntries);
    return dest;
  }

  private async readDir(): Promise<DirEntry[]> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          path: join(this.dir, e.name),
          isDir: false,
          status: "normal" as const,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("Failed to read detached files directory", { error: err });
      }
      return [];
    }
  }

  private async handleFlush(changes: FileChange[]): Promise<void> {
    const oldNames = new Set(this.cachedEntries.map((e) => e.name));
    this.cachedEntries = await this.readDir();
    const newNames = new Set(this.cachedEntries.map((e) => e.name));

    // Detect list changes (files added or removed)
    const listChanged =
      oldNames.size !== newNames.size ||
      [...oldNames].some((n) => !newNames.has(n)) ||
      [...newNames].some((n) => !oldNames.has(n));

    if (listChanged) {
      this.onListChanged(this.cachedEntries);
    }

    // Fire content-changed for files that existed before and still exist (i.e., modified)
    if (this.onFileChanged) {
      for (const { key, nonces } of changes) {
        if (oldNames.has(key) && newNames.has(key)) {
          this.onFileChanged(join(this.dir, key), nonces);
        }
      }
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
