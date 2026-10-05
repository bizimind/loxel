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
