import { $ } from "bun";
import {
  chmod,
  constants,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { FileOperationResult } from "@/api/file-operations-model";

import { logger } from "./logger";

const log = logger.child("files");

// oxlint-disable-next-line no-control-regex -- intentional: reject null bytes in paths
const SAFE_PATH_PATTERN = /^(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[^<>:"|?*\0]+$/;

const MAX_UNDO_ENTRIES = 50;
const MAX_UNDO_BYTES = 50 * 1024 * 1024; // 50 MB

// --- Undo entry types ---

interface RenameEntry {
  type: "rename";
  oldPath: string;
  newPath: string;
  usedGit: boolean;
}

interface MoveEntry {
  type: "move";
  oldPath: string;
  newPath: string;
  usedGit: boolean;
}

interface FileEntry {
  relativePath: string;
  content: Buffer;
  mode: number;
}

interface SymlinkEntry {
  relativePath: string;
  linkTarget: string;
}

interface DeleteFileEntry {
  type: "delete-file";
  path: string;
  content: Buffer;
  mode: number;
  wasTracked: boolean;
}

interface DeleteDirEntry {
  type: "delete-dir";
  path: string;
  files: FileEntry[];
  symlinks: SymlinkEntry[];
  wasTracked: boolean;
}

interface CreateFileEntry {
  type: "create-file";
  path: string;
}

interface CreateDirEntry {
  type: "create-dir";
  path: string;
}

type UndoEntry =
  | RenameEntry
  | MoveEntry
  | DeleteFileEntry
  | DeleteDirEntry
  | CreateFileEntry
  | CreateDirEntry;

function entryBytes(entry: UndoEntry): number {
  switch (entry.type) {
    case "rename":
    case "move":
    case "create-file":
    case "create-dir":
      return 0;
    case "delete-file":
      return entry.content.byteLength;
    case "delete-dir":
      return entry.files.reduce((sum, f) => sum + f.content.byteLength, 0);
    default: {
      const _exhaustive: never = entry;
      throw new Error(`Unknown undo entry type: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Manages file rename/delete/move operations with git integration and undo/redo.
 *
 * Uses `git mv` / `git rm` for tracked files, falls back to raw FS ops for untracked.
 * All operations are serialized through an async queue to prevent concurrent corruption.
 */
export class FileOperationsService {
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private totalBytes = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private worktreeCwd: string) {}

  // --- Public API ---

  async rename(relPath: string, newName: string): Promise<{ newPath: string }> {
    return this.enqueue(() => this.doRename(relPath, newName));
  }

  async delete(relPath: string): Promise<void> {
    return this.enqueue(() => this.doDelete(relPath));
  }

  async move(srcPath: string, destDir: string): Promise<{ newPath: string }> {
    return this.enqueue(() => this.doMove(srcPath, destDir));
  }

  async createFile(dir: string, name: string): Promise<{ path: string }> {
    return this.enqueue(() => this.doCreateFile(dir, name));
  }

  async createDir(dir: string, name: string): Promise<{ path: string }> {
    return this.enqueue(() => this.doCreateDir(dir, name));
  }

  async copy(srcPath: string, destDir: string): Promise<{ newPath: string }> {
    return this.enqueue(() => this.doCopy(srcPath, destDir));
  }

  async undo(): Promise<FileOperationResult | null> {
    return this.enqueue(() => this.doUndo());
  }

  async redo(): Promise<FileOperationResult | null> {
    return this.enqueue(() => this.doRedo());
  }

  dispose(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.totalBytes = 0;
  }

  // --- Serialization ---

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  // --- Rename ---

  private async doRename(relPath: string, newName: string): Promise<{ newPath: string }> {
    validatePath(relPath);
    validateName(newName);

    const parentDir = dirname(relPath);
    const newRelPath = parentDir === "." ? newName : `${parentDir}/${newName}`;

    if (relPath === newRelPath) return { newPath: relPath };

    validatePath(newRelPath);
    await this.assertNotExists(newRelPath);

    const usedGit = await this.tryGitMv(relPath, newRelPath);

    this.pushUndo({ type: "rename", oldPath: relPath, newPath: newRelPath, usedGit });
    log.info(`Renamed ${relPath} → ${newRelPath}${usedGit ? " (git)" : ""}`);
    return { newPath: newRelPath };
  }

  // --- Delete ---

  private async doDelete(relPath: string): Promise<void> {
    validatePath(relPath);
    const fullPath = this.abs(relPath);
    const st = await lstat(fullPath);

    if (st.isDirectory()) {
      await this.doDeleteDir(relPath, fullPath);
    } else {
      await this.doDeleteFile(relPath, fullPath, st.mode);
    }
  }

  private async doDeleteFile(relPath: string, fullPath: string, mode: number): Promise<void> {
    const content = await readFile(fullPath);
    const wasTracked = await this.isGitTracked(relPath);
    if (wasTracked) {
      await this.gitRm(relPath);
    } else {
      await rm(fullPath, { force: true });
    }

    this.pushUndo({ type: "delete-file", path: relPath, content, mode, wasTracked });
    log.info(`Deleted file ${relPath}${wasTracked ? " (git)" : ""}`);
  }

  private async doDeleteDir(relPath: string, fullPath: string): Promise<void> {
    // Collect all files and symlinks for undo before deleting
    const files: FileEntry[] = [];
    const symlinks: SymlinkEntry[] = [];
    await this.collectDirContents(fullPath, relPath, files, symlinks);

    const wasTracked = await this.isGitTracked(relPath);
    if (wasTracked) {
      await this.gitRmDir(relPath);
    } else {
      await rm(fullPath, { recursive: true, force: true });
    }

    this.pushUndo({ type: "delete-dir", path: relPath, files, symlinks, wasTracked });
    log.info(`Deleted directory ${relPath} (${files.length} files)${wasTracked ? " (git)" : ""}`);
  }

  private async collectDirContents(
    absDir: string,
    relDir: string,
    files: FileEntry[],
    symlinks: SymlinkEntry[],
  ): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = join(absDir, entry.name);
      const relPath = `${relDir}/${entry.name}`;

      if (entry.isSymbolicLink()) {
        const target = await readlink(absPath);
        symlinks.push({ relativePath: relPath, linkTarget: target });
      } else if (entry.isDirectory()) {
        await this.collectDirContents(absPath, relPath, files, symlinks);
      } else {
        const st = await stat(absPath);
        const content = await readFile(absPath);
        files.push({ relativePath: relPath, content, mode: st.mode });
      }
    }
  }

  // --- Move ---

  private async doMove(srcPath: string, destDir: string): Promise<{ newPath: string }> {
    validatePath(srcPath);
    if (destDir) validatePath(destDir);

    const name = srcPath.split("/").pop()!;
    const newPath = destDir ? `${destDir}/${name}` : name;

    if (srcPath === newPath) return { newPath: srcPath };

    // Prevent moving directory into itself or a descendant
    if (newPath.startsWith(srcPath + "/")) {
      throw new Error("Cannot move a directory into itself");
    }

    validatePath(newPath);
    await this.assertNotExists(newPath);

    // Ensure destination directory exists
    const destFullDir = destDir ? join(this.worktreeCwd, destDir) : this.worktreeCwd;
    await mkdir(destFullDir, { recursive: true });

    const usedGit = await this.tryGitMv(srcPath, newPath);

    this.pushUndo({ type: "move", oldPath: srcPath, newPath, usedGit });
    log.info(`Moved ${srcPath} → ${newPath}${usedGit ? " (git)" : ""}`);
    return { newPath };
  }

  // --- Create file ---

  private async doCreateFile(dir: string, name: string): Promise<{ path: string }> {
    if (dir) validatePath(dir);
    validateName(name);

    const resolvedName = await this.resolveCollisionName(dir, name);
    const relPath = dir ? `${dir}/${resolvedName}` : resolvedName;
    const fullPath = this.abs(relPath);

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, "");

    this.pushUndo({ type: "create-file", path: relPath });
    log.info(`Created file ${relPath}`);
    return { path: relPath };
  }

  // --- Create directory ---

  private async doCreateDir(dir: string, name: string): Promise<{ path: string }> {
    if (dir) validatePath(dir);
    validateName(name);

    const resolvedName = await this.resolveCollisionName(dir, name);
    const relPath = dir ? `${dir}/${resolvedName}` : resolvedName;
    const fullPath = this.abs(relPath);

    await mkdir(fullPath, { recursive: true });

    this.pushUndo({ type: "create-dir", path: relPath });
    log.info(`Created directory ${relPath}`);
    return { path: relPath };
  }

  // --- Copy ---

  private async doCopy(srcPath: string, destDir: string): Promise<{ newPath: string }> {
    validatePath(srcPath);
    if (destDir) validatePath(destDir);

    const srcName = srcPath.split("/").pop()!;
    // Try original name first; only add "(copy)" suffix if it collides
    const candidatePath = destDir ? `${destDir}/${srcName}` : srcName;
    const needsSuffix = await this.pathExists(candidatePath);
    const resolvedName = needsSuffix ? await this.resolveCopyName(destDir, srcName) : srcName;
    const newPath = destDir ? `${destDir}/${resolvedName}` : resolvedName;

    const srcFull = this.abs(srcPath);
    const destFull = this.abs(newPath);
    const st = await lstat(srcFull);

    await mkdir(dirname(destFull), { recursive: true });

    if (st.isDirectory()) {
      await this.copyDirRecursive(srcFull, destFull);
      this.pushUndo({ type: "create-dir", path: newPath });
    } else {
      await copyFile(srcFull, destFull);
      await chmod(destFull, st.mode);
      this.pushUndo({ type: "create-file", path: newPath });
    }

    log.info(`Copied ${srcPath} → ${newPath}`);
    return { newPath };
  }

  // --- Undo ---

  private async doUndo(): Promise<FileOperationResult | null> {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.totalBytes -= entryBytes(entry);

    try {
      return await this.executeUndo(entry);
    } catch (err) {
      // Re-push the entry so it's not lost on failure
      this.undoStack.push(entry);
      this.totalBytes += entryBytes(entry);
      throw err;
    }
  }

  private async executeUndo(entry: UndoEntry): Promise<FileOperationResult> {
    switch (entry.type) {
      case "rename":
      case "move": {
        if (entry.usedGit) {
          await this.tryGitMv(entry.newPath, entry.oldPath);
        } else {
          await this.rawRename(entry.newPath, entry.oldPath);
        }
        this.redoStack.push(entry);
        log.info(`Undo ${entry.type}: ${entry.newPath} → ${entry.oldPath}`);
        return { type: entry.type, oldPath: entry.newPath, newPath: entry.oldPath };
      }
      case "delete-file": {
        await this.restoreFile(entry.path, entry.content, entry.mode, entry.wasTracked);
        this.redoStack.push(entry);
        log.info(`Undo delete: restored ${entry.path}`);
        return { type: "restore", path: entry.path };
      }
      case "delete-dir": {
        await this.restoreDir(entry);
        this.redoStack.push(entry);
        log.info(`Undo delete: restored directory ${entry.path}`);
        return { type: "restore", path: entry.path };
      }
      case "create-file": {
        await rm(this.abs(entry.path), { force: true });
        this.redoStack.push(entry);
        log.info(`Undo create file: ${entry.path}`);
        return { type: "delete", path: entry.path };
      }
      case "create-dir": {
        await rm(this.abs(entry.path), { recursive: true, force: true });
        this.redoStack.push(entry);
        log.info(`Undo create dir: ${entry.path}`);
        return { type: "delete", path: entry.path };
      }
      default: {
        const _exhaustive: never = entry;
        throw new Error(`Unknown undo entry type: ${String(_exhaustive)}`);
      }
    }
  }

  // --- Redo ---

  private async doRedo(): Promise<FileOperationResult | null> {
    const entry = this.redoStack.pop();
    if (!entry) return null;

    switch (entry.type) {
      case "rename":
      case "move": {
        // Re-apply: move oldPath to newPath again
        if (entry.usedGit) {
          await this.tryGitMv(entry.oldPath, entry.newPath);
        } else {
          await this.rawRename(entry.oldPath, entry.newPath);
        }
        this.totalBytes += entryBytes(entry);
        this.undoStack.push(entry);
        log.info(`Redo ${entry.type}: ${entry.oldPath} → ${entry.newPath}`);
        return { type: entry.type, oldPath: entry.oldPath, newPath: entry.newPath };
      }
      case "delete-file": {
        // Re-read content before re-deleting so undo gets fresh data
        const fullPath = this.abs(entry.path);
        const freshContent = await readFile(fullPath);
        const freshStat = await stat(fullPath);
        if (entry.wasTracked) {
          await this.gitRm(entry.path);
        } else {
          await rm(fullPath, { force: true });
        }
        const freshEntry: DeleteFileEntry = {
          ...entry,
          content: freshContent,
          mode: freshStat.mode,
        };
        this.totalBytes += entryBytes(freshEntry);
        this.undoStack.push(freshEntry);
        log.info(`Redo delete: ${entry.path}`);
        return { type: "delete", path: entry.path };
      }
      case "delete-dir": {
        // Re-collect directory contents before re-deleting so undo gets fresh data
        const fullPath = this.abs(entry.path);
        const freshFiles: FileEntry[] = [];
        const freshSymlinks: SymlinkEntry[] = [];
        await this.collectDirContents(fullPath, entry.path, freshFiles, freshSymlinks);
        if (entry.wasTracked) {
          await this.gitRmDir(entry.path);
        } else {
          await rm(fullPath, { recursive: true, force: true });
        }
        const freshDirEntry: DeleteDirEntry = {
          ...entry,
          files: freshFiles,
          symlinks: freshSymlinks,
        };
        this.totalBytes += entryBytes(freshDirEntry);
        this.undoStack.push(freshDirEntry);
        log.info(`Redo delete: directory ${entry.path}`);
        return { type: "delete", path: entry.path };
      }
      case "create-file": {
        // Redo create = recreate empty file
        const fullPath = this.abs(entry.path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, "");
        this.undoStack.push(entry);
        log.info(`Redo create file: ${entry.path}`);
        return { type: "create", path: entry.path };
      }
      case "create-dir": {
        // Redo create = recreate directory
        await mkdir(this.abs(entry.path), { recursive: true });
        this.undoStack.push(entry);
        log.info(`Redo create dir: ${entry.path}`);
        return { type: "create", path: entry.path };
      }
      default: {
        const _exhaustive: never = entry;
        throw new Error(`Unknown undo entry type: ${String(_exhaustive)}`);
      }
    }
  }

  // --- Undo stack management ---

  private pushUndo(entry: UndoEntry): void {
    // Clear redo stack on new forward operation
    this.redoStack = [];

    const bytes = entryBytes(entry);

    // Evict content-bearing entries if we'd exceed the byte budget
    while (this.totalBytes + bytes > MAX_UNDO_BYTES && this.undoStack.length > 0) {
      const oldest = this.findOldestContentEntry();
      if (oldest === -1) break;
      this.totalBytes -= entryBytes(this.undoStack[oldest]!);
      this.undoStack.splice(oldest, 1);
    }

    // Evict oldest entry if at count limit
    while (this.undoStack.length >= MAX_UNDO_ENTRIES) {
      const removed = this.undoStack.shift();
      if (removed) this.totalBytes -= entryBytes(removed);
    }

    this.undoStack.push(entry);
    this.totalBytes += bytes;
  }

  private findOldestContentEntry(): number {
    for (let i = 0; i < this.undoStack.length; i++) {
      if (entryBytes(this.undoStack[i]!) > 0) return i;
    }
    return -1;
  }

  // --- Restore helpers ---

  private async restoreFile(
    relPath: string,
    content: Buffer,
    mode: number,
    wasTracked: boolean,
  ): Promise<void> {
    const fullPath = this.abs(relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, { mode });
    if (wasTracked) {
      await $`git -C ${this.worktreeCwd} add -- ${relPath}`.quiet().catch((err: unknown) => {
        log.warn("Failed to git add restored file", { path: relPath, error: err });
      });
    }
  }

  private async restoreDir(entry: DeleteDirEntry): Promise<void> {
    // Restore files
    for (const file of entry.files) {
      const fullPath = this.abs(file.relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.content, { mode: file.mode });
    }
    // Restore symlinks
    for (const link of entry.symlinks) {
      const fullPath = this.abs(link.relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await symlink(link.linkTarget, fullPath).catch(() => {
        // Symlink target may not exist anymore — log but don't fail
        log.warn("Failed to restore symlink", { path: link.relativePath, target: link.linkTarget });
      });
    }
    // Re-add to git if was tracked
    if (entry.wasTracked) {
      await $`git -C ${this.worktreeCwd} add -- ${entry.path}`.quiet().catch((err: unknown) => {
        log.warn("Failed to git add restored directory", { path: entry.path, error: err });
      });
    }
  }

  // --- Git helpers ---

  /** Try `git mv`. Returns true if git handled it, false if untracked (fell back to raw rename). */
  private async tryGitMv(from: string, to: string): Promise<boolean> {
    // Ensure destination parent exists
    const destParent = dirname(to);
    if (destParent !== ".") {
      await mkdir(join(this.worktreeCwd, destParent), { recursive: true });
    }

    try {
      await $`git -C ${this.worktreeCwd} mv -- ${from} ${to}`.quiet();
      return true;
    } catch {
      // Fall back to raw rename for untracked files
      await this.rawRename(from, to);
      return false;
    }
  }

  /** Check if a path is tracked by git (in HEAD or index). */
  private async isGitTracked(relPath: string): Promise<boolean> {
    try {
      const out = await $`git -C ${this.worktreeCwd} ls-files -- ${relPath}`.text();
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Remove a tracked file via `git rm`. Throws on unexpected errors. */
  private async gitRm(relPath: string): Promise<void> {
    await $`git -C ${this.worktreeCwd} rm -f -- ${relPath}`.quiet();
  }

  /** Remove a tracked directory via `git rm -r`, then clean up any remaining untracked files. */
  private async gitRmDir(relPath: string): Promise<void> {
    await $`git -C ${this.worktreeCwd} rm -rf -- ${relPath}`.quiet();
    // git rm -rf only removes tracked files — clean up any remaining untracked files
    await rm(this.abs(relPath), { recursive: true, force: true }).catch(() => {});
  }

  // --- Raw FS helpers ---

  private async rawRename(fromRel: string, toRel: string): Promise<void> {
    const fromAbs = this.abs(fromRel);
    const toAbs = this.abs(toRel);

    // Ensure destination parent exists
    await mkdir(dirname(toAbs), { recursive: true });

    try {
      await rename(fromAbs, toAbs);
    } catch (err: unknown) {
      // Cross-filesystem: copy + delete
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        const st = await lstat(fromAbs);
        if (st.isDirectory()) {
          await this.copyDirRecursive(fromAbs, toAbs);
          await rm(fromAbs, { recursive: true, force: true });
        } else {
          await copyFile(fromAbs, toAbs, constants.COPYFILE_EXCL);
          await chmod(toAbs, st.mode);
          await rm(fromAbs, { force: true });
        }
      } else {
        throw err;
      }
    }
  }

  private async copyDirRecursive(src: string, dest: string): Promise<void> {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirRecursive(srcPath, destPath);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(srcPath);
        await symlink(target, destPath);
      } else {
        await copyFile(srcPath, destPath);
        const st = await stat(srcPath);
        await chmod(destPath, st.mode);
      }
    }
  }

  /**
   * Resolve a name collision by appending a number: "file.ts" → "file 2.ts" → "file 3.ts".
   * For copy operations, uses "(copy)" suffix: "file.ts" → "file (copy).ts" → "file (copy 2).ts".
   */
  private async resolveCollisionName(dir: string, name: string): Promise<string> {
    const relPath = dir ? `${dir}/${name}` : name;
    const exists = await this.pathExists(relPath);
    if (!exists) return name;

    const dotIdx = name.lastIndexOf(".");
    const hasExt = dotIdx > 0;
    const baseName = hasExt ? name.slice(0, dotIdx) : name;
    const ext = hasExt ? name.slice(dotIdx) : "";

    for (let n = 2; n <= 100; n++) {
      const candidate = `${baseName} ${n}${ext}`;
      const candidatePath = dir ? `${dir}/${candidate}` : candidate;
      const candidateExists = await this.pathExists(candidatePath);
      if (!candidateExists) return candidate;
    }
    throw new Error(`Too many collisions for "${name}"`);
  }

  /** Resolve a copy name: "file.ts" → "file (copy).ts" → "file (copy 2).ts". */
  private async resolveCopyName(dir: string, name: string): Promise<string> {
    const dotIdx = name.lastIndexOf(".");
    const hasExt = dotIdx > 0;
    const baseName = hasExt ? name.slice(0, dotIdx) : name;
    const ext = hasExt ? name.slice(dotIdx) : "";

    // Try "name (copy).ext" first
    const copyName = `${baseName} (copy)${ext}`;
    const copyPath = dir ? `${dir}/${copyName}` : copyName;
    const copyExists = await this.pathExists(copyPath);
    if (!copyExists) return copyName;

    // Then try "name (copy 2).ext", "name (copy 3).ext", ...
    for (let n = 2; n <= 100; n++) {
      const candidate = `${baseName} (copy ${n})${ext}`;
      const candidatePath = dir ? `${dir}/${candidate}` : candidate;
      const candidateExists = await this.pathExists(candidatePath);
      if (!candidateExists) return candidate;
    }
    throw new Error(`Too many copies of "${name}"`);
  }

  private async pathExists(relPath: string): Promise<boolean> {
    try {
      await lstat(this.abs(relPath));
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  private async assertNotExists(relPath: string): Promise<void> {
    try {
      await lstat(this.abs(relPath));
      throw new Error(`Already exists: ${relPath}`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  private abs(relPath: string): string {
    return join(this.worktreeCwd, relPath);
  }
}

// --- Validation ---

function validatePath(p: string): void {
  if (!SAFE_PATH_PATTERN.test(p) || p.includes("..") || p.startsWith("/")) {
    throw new Error(`Invalid path: ${p}`);
  }
}

function validateName(name: string): void {
  if (
    !name ||
    name !== name.trim() ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..")
  ) {
    throw new Error(`Invalid name: ${name}`);
  }
  if (name === "." || name === "..") {
    throw new Error(`Invalid name: ${name}`);
  }
  // Reject control characters (U+0000–U+001F, U+007F)
  // oxlint-disable-next-line no-control-regex -- intentional: reject control chars in filenames
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new Error(`Invalid name: contains control characters`);
  }
}
