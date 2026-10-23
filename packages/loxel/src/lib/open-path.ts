import * as api from "@/api/client";
import { wsClient } from "@/api/client";
import type { PanelOpenOptions } from "@/api/panel-placement-model";
import type { OpenTerminalPanel } from "@/api/ws-protocol";
import { showToast } from "@/components/ui/toast";
import { queryKeys } from "@/queries/query-keys";
import { queryClient } from "@/query-client";
import { deriveProject, useProjectStore, whenProjectsLoaded } from "@/store/projects";
import { useSettingsStore } from "@/store/settings-store";
import { getCenterApiWorktree, showPanel, showPanelAfterLayoutRestore } from "@/store/tools-bar";
import type { PendingOpen } from "@/store/worktree-ui";
import { getCurrentWorktreeUI, getWorktreeUI } from "@/store/worktree-ui";
import { deriveOwningWorktree, useWorktreeStore } from "@/store/worktrees";

import { frontendLog } from "./frontend-logger";
import { dispatchLoxelEvent } from "./loxel-events";
import type { FileLocation } from "./open-file";
import { dispatchOpenFile } from "./open-file";
import { WINDOW_ID } from "./window-id";

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
 * Open a terminal sent from outside the window (`loxel terminal`). The shell starts in `cwd`; the
 * panel goes to the worktree containing `cwd`, switching to it if needed, else to the active one.
 * A worktree created moments ago (`wt add` from a shell) may not be listed yet, so the owning
 * project's worktrees are refreshed before giving up on finding an owner.
 */
export async function openTerminal(terminal: OpenTerminalPanel): Promise<void> {
  await whenProjectsLoaded();
  const { projects } = useProjectStore.getState();
  const { activeWorktreePath, byProject, refreshProjectWorktrees } = useWorktreeStore.getState();

  let owner = deriveOwningWorktree(terminal.cwd, projects, byProject);
  if (!owner) {
    const project = deriveProject(terminal.cwd, projects);
    if (project) {
      await refreshProjectWorktrees(project.path);
      owner = deriveOwningWorktree(terminal.cwd, projects, useWorktreeStore.getState().byProject);
    }
  }

  const target = owner ?? activeWorktreePath;
  if (!target) {
    showToast("Open a project before opening terminals");
    return;
  }
  // Without focus the panel may not mount for a while (a background tab, or a worktree the user is
  // not on), but its command must run now, so the shell is started without it.
  if (terminal.focus === false) {
    wsClient.send({
      type: "terminal_spawn",
      id: terminal.terminalId,
      cwd: terminal.cwd,
      worktreePath: target,
      scrollbackLines: useSettingsStore.getState().terminal.scrollbackLines,
      windowId: WINDOW_ID,
    });
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
