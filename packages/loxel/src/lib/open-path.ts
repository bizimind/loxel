import * as api from "@/api/client";
import { showToast } from "@/components/ui/toast";
import { queryKeys } from "@/queries/query-keys";
import { queryClient } from "@/query-client";
import { deriveProject, useProjectStore, whenProjectsLoaded } from "@/store/projects";
import { getCenterApiWorktree, showPanel, showPanelAfterLayoutRestore } from "@/store/tools-bar";
import { getCurrentWorktreeUI, getWorktreeUI } from "@/store/worktree-ui";
import { deriveOwningWorktree, useWorktreeStore } from "@/store/worktrees";

import { frontendLog } from "./frontend-logger";
import type { FileLocation } from "./open-file";
import { dispatchOpenFile } from "./open-file";

const log = frontendLog.child("files");

/**
 * Show a folder in the project files panel. A folder inside a worktree is revealed in that
 * worktree, switching to it if needed; any other folder is opened in the active worktree's Others
 * section.
 */
export async function openFolder(rawPath: string): Promise<void> {
  await whenProjectsLoaded();
  const path = rawPath.replace(/(.)\/+$/, "$1");
  const { projects } = useProjectStore.getState();
  const { activeWorktreePath, switchWorktree, byProject } = useWorktreeStore.getState();

  const owner = deriveOwningWorktree(path, projects, byProject);
  if (owner) {
    if (owner === activeWorktreePath) {
      showPanel("projectFiles");
    } else {
      await switchWorktree(owner);
      showPanelAfterLayoutRestore("projectFiles");
    }
    // The switch sets the active worktree synchronously, so this targets the owner's store.
    getCurrentWorktreeUI().getState().setPendingRevealFolder(path);
    return;
  }

  const project = deriveProject(path, projects);
  if (project) {
    showToast(`${path} is inside ${project.name} but not in any of its worktrees`);
    return;
  }
  if (!activeWorktreePath) {
    showToast("Open a project before opening other folders");
    return;
  }

  try {
    await api.addExternalFolder(activeWorktreePath, path);
  } catch (err) {
    log.error("Failed to open folder", { error: err instanceof Error ? err : undefined, path });
    showToast(err instanceof Error ? err.message : "Failed to open folder");
    return;
  }
  const projectPath = deriveProject(activeWorktreePath, projects)?.path ?? null;
  await queryClient.invalidateQueries({
    queryKey: queryKeys.externalFiles(projectPath, activeWorktreePath),
  });
  showPanel("projectFiles");
  getCurrentWorktreeUI().getState().setPendingRevealFolder(path);
}

/**
 * Open a file sent from outside the window (`loxel <file>`, Finder). A file inside a worktree opens
 * in that worktree, switching to it if needed; any other file opens in the active worktree's
 * Others section.
 */
export async function openFile(path: string): Promise<void> {
  await whenProjectsLoaded();
  const { projects } = useProjectStore.getState();
  const { activeWorktreePath, switchWorktree, byProject } = useWorktreeStore.getState();

  const target = deriveOwningWorktree(path, projects, byProject) ?? activeWorktreePath;
  if (!target) {
    showToast("Open a project before opening other files");
    return;
  }

  // Open now if the target's editor area is mounted; otherwise — while a worktree switch swaps it
  // in, or before it first mounts — queue the file for it, behind any file already waiting there.
  const ui = getWorktreeUI(target).getState();
  const centerReady = target === activeWorktreePath && getCenterApiWorktree() === target;
  if (centerReady && ui.pendingOpenFiles.length === 0) {
    dispatchOpenFile(path);
    return;
  }
  ui.queueOpenFile(path);
  if (target !== activeWorktreePath) await switchWorktree(target);
}

/**
 * Open a path whose type is unknown (e.g. a terminal link): folders go to {@link openFolder},
 * files to their editor. Missing paths still open an editor, which reports the error.
 */
export async function openPath(path: string, location?: FileLocation): Promise<void> {
  const info = await api.getPathInfo(path).catch(() => null);
  if (info?.isDir) {
    await openFolder(info.path);
    return;
  }
  dispatchOpenFile(info?.path ?? path, location);
}
