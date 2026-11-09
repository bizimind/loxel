import type { WorkspaceFileSystem, WorkspaceFileType } from "@bizimind/monaco-lsp-client";
import type * as monaco from "monaco-editor";

import * as api from "@/api/client";
import { ApiError } from "@/api/client";
import { invalidateDirQueries } from "@/queries/query-helpers";

import { deleteFile, moveFile, renameFile } from "./file-operations";
import { editorFilePath } from "./live-editor-model";
import { pathName, relativeTo } from "./project-file-helpers";

/**
 * Folders whose files are not the worktree's own project, so language-server edits never change
 * them and Go to Symbol ranks them last: dependencies, Python environments kept in the worktree
 * (whose standard library copies live outside `site-packages`), git's own, and other worktrees
 * nested in this one (`wt`'s `.worktrees`).
 */
const PROTECTED_SEGMENTS = new Set([
  "node_modules",
  "site-packages",
  "dist-packages",
  "__pypackages__",
  ".venv",
  "venv",
  ".tox",
  ".nox",
  ".pixi",
  ".conda",
  ".git",
  ".gradle",
  ".m2",
  ".worktrees",
]);

/**
 * The disk side of language-server workspace edits (rename, code actions, `workspace/applyEdit`)
 * for worktree `wtPath`. Files with no editor model are read and written through the file-content
 * routes, unformatted; files are created, renamed, moved and deleted through the file-operation
 * routes, so open tabs follow, the files panel refreshes, and its undo covers those operations.
 *
 * Only files of the worktree itself are changed through it: never anything outside it (the
 * standard library, an environment elsewhere, Others folders, drafts), under a dependency folder
 * (`node_modules`, `site-packages`) or under `.git`. Lexical paths are checked first, then their
 * real paths, so a symlink cannot lead an edit out of the worktree. Files open in an editor are
 * the exception: text edits change their model, wherever they are, as typing would, and never
 * reach this file system.
 */
export function createLspWorkspaceFiles(wtPath: string): WorkspaceFileSystem {
  let realRoot: Promise<string> | undefined;
  const getRealRoot = () =>
    (realRoot ??= api.getPathInfo(wtPath).then(
      (info) => info.path,
      (error: unknown) => {
        realRoot = undefined;
        throw error;
      },
    ));

  /** Creates `dir` and its missing parents inside the worktree. */
  async function ensureDir(dir: string): Promise<void> {
    if (dir === wtPath || (await pathInfo(dir))) return;
    const parent = parentOf(dir);
    await ensureDir(parent);
    const { path } = await api.createProjectDir(wtPath, { dir: parent, name: pathName(dir) });
    invalidateDirQueries(parent);
    if (path !== dir) await refuseStray(path, `${dir} already exists`);
  }

  /** Removes what a create route made under a free name (the path appeared meanwhile), then throws. */
  async function refuseStray(stray: string, reason: string): Promise<never> {
    await deleteFile({ wt: wtPath, path: stray, isDetached: false });
    throw new Error(reason);
  }

  return {
    async stat(uri: monaco.Uri): Promise<WorkspaceFileType | undefined> {
      const path = editablePath(uri, wtPath);
      const info = await pathInfo(path);
      if (info) {
        assertWorktreeFile(info.path, await getRealRoot());
        return info.isDir ? "directory" : "file";
      }
      // Nothing there yet: the nearest existing folder is where it would be created.
      for (let dir = parentOf(path); dir !== wtPath; dir = parentOf(dir)) {
        const dirInfo = await pathInfo(dir);
        if (dirInfo) {
          assertWorktreeFile(dirInfo.path, await getRealRoot());
          break;
        }
      }
      return undefined;
    },

    async readFile(uri) {
      const path = editablePath(uri, wtPath);
      const { content } = await api.getFileContentByPath(path, wtPath);
      // The route decodes as UTF-8, replacing invalid bytes: writing that back would corrupt the file.
      if (content.includes("\uFFFD"))
        throw new Error(`${path} is not UTF-8 text, so it is not changed`);
      return content;
    },

    async writeFile(uri, content) {
      const path = editablePath(uri, wtPath);
      await api.writeFileContent({
        path,
        content,
        nonce: crypto.randomUUID(),
        worktreePath: wtPath,
      });
    },

    async createFile(uri) {
      const path = editablePath(uri, wtPath);
      const dir = parentOf(path);
      await ensureDir(dir);
      const created = await api.createProjectFile(wtPath, { dir, name: pathName(path) });
      invalidateDirQueries(dir);
      // The route picks a free name when the file appeared meanwhile.
      if (created.path !== path) await refuseStray(created.path, `${path} already exists`);
    },

    async rename(source, target) {
      const sourcePath = editablePath(source, wtPath);
      const targetPath = editablePath(target, wtPath);
      const targetDir = parentOf(targetPath);
      const newName = pathName(targetPath);
      let path: string;
      if (parentOf(sourcePath) === targetDir) {
        path = await renameFile({ wt: wtPath, path: sourcePath, newName, isDetached: false });
      } else {
        await ensureDir(targetDir);
        path = await moveFile({ wt: wtPath, srcPath: sourcePath, destDir: targetDir, newName });
      }
      if (path !== targetPath) throw new Error(`${sourcePath} was moved to ${path} instead`);
    },

    async delete(uri) {
      await deleteFile({ wt: wtPath, path: editablePath(uri, wtPath), isDetached: false });
    },
  };
}

/** Whether a worktree-relative path is under one of the {@link PROTECTED_SEGMENTS} folders. */
export function isInProtectedFolder(relativePath: string): boolean {
  return relativePath.split("/").some((s) => PROTECTED_SEGMENTS.has(s));
}

/** The absolute path of a worktree file's editor URI (see `editorFilePath`), checked lexically. */
function editablePath(uri: monaco.Uri, wtPath: string): string {
  const path = editorFilePath(uri);
  if (path === null) throw new Error(`${uri.toString(true)} is not a file of the worktree`);
  assertWorktreeFile(path, wtPath);
  return path;
}

function assertWorktreeFile(path: string, root: string): void {
  const relative = relativeTo(path, root);
  const segments = relative?.split("/") ?? [];
  if (!relative || segments.some((s) => s === "." || s === ".." || s === "")) {
    throw new Error(`${path} is outside the worktree`);
  }
  if (isInProtectedFolder(relative)) {
    throw new Error(`${path} belongs to a dependency, an environment or git, so it is not changed`);
  }
}

/** The real path and kind of `path`, or undefined when nothing is there. */
async function pathInfo(path: string): Promise<{ path: string; isDir: boolean } | undefined> {
  try {
    return await api.getPathInfo(path);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}
