import * as api from "@/api/client";
import { fileParentDir } from "@/lib/project-file-helpers";
import { invalidateDirQueries } from "@/queries/query-helpers";
import { getCurrentWorktreeUI } from "@/store/worktree-ui";

/**
 * Rename a file or directory in the active worktree, one of its Others folders, or its Drafts,
 * then tell the rest of the app: remap the worktree's UI paths, move any open editor tab to
 * the new path (`loxel-file-moved`) and refresh the parent directory listing.
 *
 * Returns the new absolute path. Throws when the server refuses the rename.
 */
export async function renameFile(options: {
  wt: string;
  path: string;
  newName: string;
  isDetached: boolean;
}): Promise<string> {
  const { wt, path, newName, isDetached } = options;
  let newPath: string;
  if (isDetached) {
    await api.renameDetachedFile(wt, path, newName);
    newPath = path.slice(0, path.lastIndexOf("/") + 1) + newName;
  } else {
    ({ newPath } = await api.renameProjectFile(wt, { path, newName }));
  }
  getCurrentWorktreeUI().getState().renameProjectPaths(path, newPath);
  window.dispatchEvent(new CustomEvent("loxel-file-moved", { detail: { oldPath: path, newPath } }));
  invalidateDirQueries(fileParentDir(path, wt));
  return newPath;
}

/**
 * Move a file or directory of worktree `wt` (or one of its Others folders) into `destDir`
 * (empty for the worktree root), keeping its name, and tell the rest of the app like
 * `renameFile`. Returns the new absolute path. Throws when the server refuses the move.
 */
export async function moveFile(options: {
  wt: string;
  srcPath: string;
  destDir: string;
}): Promise<string> {
  const { wt, srcPath, destDir } = options;
  const { newPath } = await api.moveProjectFile(wt, { srcPath, destDir });
  getCurrentWorktreeUI().getState().renameProjectPaths(srcPath, newPath);
  window.dispatchEvent(
    new CustomEvent("loxel-file-moved", { detail: { oldPath: srcPath, newPath } }),
  );
  invalidateDirQueries(fileParentDir(srcPath, wt), destDir || wt);
  return newPath;
}

/**
 * Delete a file or directory in the active worktree, one of its Others folders, or its Drafts,
 * and tell the rest of the app: close its editor tabs (`loxel-file-deleted`), drop the tree
 * selection inside it and refresh the parent directory listing. Throws when the server refuses.
 */
export async function deleteFile(options: {
  wt: string;
  path: string;
  isDetached: boolean;
}): Promise<void> {
  const { wt, path, isDetached } = options;
  if (isDetached) await api.deleteDetachedFile(wt, path);
  else await api.deleteProjectFile(wt, path);
  window.dispatchEvent(new CustomEvent("loxel-file-deleted", { detail: { filePath: path } }));
  const ui = getCurrentWorktreeUI().getState();
  const selected = ui.selectedProjectFile;
  if (selected === path || selected?.startsWith(path + "/")) ui.setSelectedProjectFile(null);
  invalidateDirQueries(fileParentDir(path, wt));
}
