import * as api from "@/api/client";
import type { PanelOpenOptions } from "@/api/panel-placement-model";
import type { OpenTerminalPanel } from "@/api/ws-protocol";
import { showToast } from "@/components/ui/toast";
import { queryKeys } from "@/queries/query-keys";
import { queryClient } from "@/query-client";
import { deriveProject, useProjectStore, whenProjectsLoaded } from "@/store/projects";
import { getCenterApiWorktree, showPanel, showPanelAfterLayoutRestore } from "@/store/tools-bar";
import type { PendingOpen } from "@/store/worktree-ui";
import { getCurrentWorktreeUI, getWorktreeUI } from "@/store/worktree-ui";
import { deriveOwningWorktree, useWorktreeStore } from "@/store/worktrees";

import { frontendLog } from "./frontend-logger";
import { dispatchLoxelEvent } from "./loxel-events";
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
    getCurrentWorktreeUI().getState().setPendingReveal({ path, expand: true });
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
  getCurrentWorktreeUI().getState().setPendingReveal({ path, expand: true });
}

/**
 * Open a file sent from outside the window (`loxel <file>`, Finder). A file inside a worktree opens
 * in that worktree, switching to it if needed; any other file opens in the active worktree's
 * Others section. `placement` is resolved in that worktree's layout once it is mounted.
 */
export async function openFile(path: string, options: PanelOpenOptions = {}): Promise<void> {
  await whenProjectsLoaded();
  const { projects } = useProjectStore.getState();
  const { activeWorktreePath, byProject } = useWorktreeStore.getState();

  const target = deriveOwningWorktree(path, projects, byProject) ?? activeWorktreePath;
  if (!target) {
    showToast("Open a project before opening other files");
    return;
  }

  await openInWorktree(target, { kind: "file", path, ...options });
}

/**
 * Open a terminal sent from outside the window (`loxel terminal`). The server has already started
 * its shell and picked its worktree; the panel goes there, switching to it if the open has focus.
 * A worktree created moments ago (`wt add` from a shell) may not be listed yet, so its project's
 * worktrees are refreshed first.
 */
export async function openTerminal(terminal: OpenTerminalPanel): Promise<void> {
  await whenProjectsLoaded();
  const { projects } = useProjectStore.getState();
  const { byProject, refreshProjectWorktrees } = useWorktreeStore.getState();
  const target = terminal.worktreePath;
  if (deriveOwningWorktree(target, projects, byProject) !== target) {
    const project = deriveProject(target, projects);
    if (project) await refreshProjectWorktrees(project.path);
  }
  await openInWorktree(target, { kind: "terminal", terminal });
}

/**
 * Open now if the target's editor area is mounted; otherwise — while a worktree switch swaps it
 * in, or before it first mounts — queue the panel for it, behind anything already waiting there.
 * An open with focus switches to the target worktree; one without waits for the user to go there.
 */
async function openInWorktree(target: string, open: PendingOpen): Promise<void> {
  const { activeWorktreePath, switchWorktree } = useWorktreeStore.getState();
  const ui = getWorktreeUI(target).getState();
  const centerReady = target === activeWorktreePath && getCenterApiWorktree() === target;
  if (centerReady && ui.pendingOpens.length === 0) {
    dispatchPendingOpen(open);
    return;
  }
  ui.queueOpen(open);
  const focus = (open.kind === "file" ? open.focus : open.terminal.focus) !== false;
  if (focus && target !== activeWorktreePath) await switchWorktree(target);
}

/**
 * Create the panel a {@link PendingOpen} describes in the mounted center layout. Creation goes
 * through the typed window events, like every other panel, so this module does not depend on the
 * panel creators.
 */
export function dispatchPendingOpen(open: PendingOpen): void {
  if (open.kind === "file") dispatchOpenFile(open.path, undefined, open);
  else dispatchLoxelEvent("loxel-create-terminal", open.terminal);
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
