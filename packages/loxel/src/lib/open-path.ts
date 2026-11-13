import * as api from "@/api/client";
import type { PanelOpenOptions } from "@/api/panel-placement-model";
import type { OpenFilePanel, OpenTerminalPanel } from "@/api/ws-protocol";
import { showToast } from "@/components/ui/toast";
import { queryKeys } from "@/queries/query-keys";
import { queryClient } from "@/query-client";
import { HOME_LAYOUT_KEY } from "@/store/active-worktree";
import { deriveProject, useProjectStore, whenProjectsLoaded } from "@/store/projects";
import { getCenterApiLayoutKey, showPanel, showPanelAfterLayoutRestore } from "@/store/tools-bar";
import type { PendingOpen } from "@/store/worktree-ui";
import { getCurrentWorktreeUI, getWorktreeUI } from "@/store/worktree-ui";
import { deriveOwningWorktree, useWorktreeStore } from "@/store/worktrees";

import { frontendLog } from "./frontend-logger";
import { dispatchLoxelEvent } from "./loxel-events";
import type { FileLocation } from "./open-file";
import { dispatchOpenFile } from "./open-file";

const log = frontendLog.child("files");

/** The opens sent from outside the window so far: each runs once the last has finished. */
let openChain: Promise<void> = Promise.resolve();

/**
 * Run an open after those before it, so the targets of one command keep their order even when one
 * has to refresh a worktree list. A failure is reported and does not stop the ones after it.
 */
function inOrder(open: () => Promise<void>): Promise<void> {
  openChain = openChain.then(open).catch((err: unknown) => {
    log.error("Failed to open", { error: err instanceof Error ? err : undefined });
    showToast(err instanceof Error ? err.message : "Failed to open");
  });
  return openChain;
}

/**
 * Show a folder in the project files panel. A folder inside a worktree is revealed in that
 * worktree, switching to it if needed; any other folder is opened in the active worktree's Others
 * section.
 */
export function openFolder(rawPath: string): Promise<void> {
  return inOrder(() => revealFolder(rawPath));
}

async function revealFolder(rawPath: string): Promise<void> {
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
  getWorktreeUI(activeWorktreePath).getState().setPendingReveal({ path, expand: true });
}

/**
 * Open a file sent from outside the window (`loxel <file>`, Finder), in the worktree named by
 * `worktreePath` if any. Otherwise a file inside a worktree opens in that worktree, switching to it
 * if needed, and any other file in the active worktree's Others section. `placement` is resolved in
 * that worktree's layout once it is mounted.
 */
export function openFile({
  filePath: path,
  worktreePath,
  ...options
}: OpenFilePanel): Promise<void> {
  return inOrder(async () => {
    await whenProjectsLoaded();
    if (worktreePath) await refreshIfUnlisted(worktreePath);
    const { projects } = useProjectStore.getState();
    const { activeWorktreePath, byProject } = useWorktreeStore.getState();

    const target =
      worktreePath ?? deriveOwningWorktree(path, projects, byProject) ?? activeWorktreePath;
    if (!target) {
      showToast("Open a project before opening other files");
      return;
    }

    await openInWorktree(target, { kind: "file", path, ...options });
  });
}

/**
 * Open a terminal sent from outside the window (`loxel terminal`, the quickstart's command field).
 * The server has already started its shell and picked its worktree, or Home (null); the panel goes
 * there, switching to the worktree if the open has focus.
 */
export function openTerminal(terminal: OpenTerminalPanel): Promise<void> {
  return inOrder(async () => {
    await whenProjectsLoaded();
    if (terminal.worktreePath) await refreshIfUnlisted(terminal.worktreePath);
    await openInWorktree(terminal.worktreePath, { kind: "terminal", terminal });
  });
}

/**
 * Open a page sent from outside the window in a browser panel: of `worktreePath` (`loxel <url>`),
 * switching to it if the open has focus, or, for a link opened with Loxel as the browser (no
 * worktree), of the active worktree, else of Home.
 */
export function openUrl(
  worktreePath: string | null,
  { url, ...options }: { url: string } & PanelOpenOptions,
): Promise<void> {
  return inOrder(async () => {
    await whenProjectsLoaded();
    if (worktreePath) await refreshIfUnlisted(worktreePath);
    const target = worktreePath ?? useWorktreeStore.getState().activeWorktreePath;
    await openInWorktree(target, { kind: "url", url, ...options });
  });
}

/**
 * Make sure a worktree the server named is in the store: one created moments ago (`wt add` from a
 * shell) may not be listed yet, so its project's worktrees are refreshed. The server vouched for
 * the worktree, so a failed refresh does not stop the open.
 */
async function refreshIfUnlisted(worktreePath: string): Promise<void> {
  const { projects } = useProjectStore.getState();
  const { byProject, refreshProjectWorktrees } = useWorktreeStore.getState();
  if (deriveOwningWorktree(worktreePath, projects, byProject) === worktreePath) return;
  const project = deriveProject(worktreePath, projects);
  if (!project) return;
  await refreshProjectWorktrees(project.path).catch((err: unknown) => {
    log.warn("Could not refresh a project's worktrees", {
      error: err instanceof Error ? err : undefined,
      project: project.path,
    });
  });
}

/**
 * Open now if the target's editor area is mounted; otherwise — while a worktree switch swaps it
 * in, or before it first mounts — queue the panel for it, behind anything already waiting there.
 * An open with focus switches to the target worktree; one without waits for the user to go there.
 * A null target is Home, which is only targeted while it is the layout shown.
 */
async function openInWorktree(target: string | null, open: PendingOpen): Promise<void> {
  const { activeWorktreePath, switchWorktree } = useWorktreeStore.getState();
  const layoutKey = target ?? HOME_LAYOUT_KEY;
  const ui = getWorktreeUI(layoutKey).getState();
  const centerReady = target === activeWorktreePath && getCenterApiLayoutKey() === layoutKey;
  if (centerReady && ui.pendingOpens.length === 0) {
    dispatchPendingOpen(open);
    return;
  }
  ui.queueOpen(open);
  const focus = (open.kind === "terminal" ? open.terminal.focus : open.focus) !== false;
  if (focus && target !== null && target !== activeWorktreePath) await switchWorktree(target);
}

/**
 * Create the panel a {@link PendingOpen} describes in the mounted center layout. Creation goes
 * through the typed window events, like every other panel, so this module does not depend on the
 * panel creators.
 */
export function dispatchPendingOpen(open: PendingOpen): void {
  switch (open.kind) {
    case "file":
      dispatchOpenFile(open.path, open.location, open);
      break;
    case "url":
      dispatchLoxelEvent("loxel-create-browser", {
        url: open.url,
        placement: open.placement,
        focus: open.focus,
      });
      break;
    case "terminal":
      dispatchLoxelEvent("loxel-create-terminal", open.terminal);
      break;
    default: {
      const _exhaustive: never = open;
      throw new Error(`Unknown pending open: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Open a path whose type is unknown (e.g. a terminal link): folders go to {@link openFolder},
 * files to their editor. Missing paths still open an editor, which reports the error. In Home,
 * which shows no worktree's files, a file opens in the worktree holding it, switching there.
 */
export async function openPath(path: string, location?: FileLocation): Promise<void> {
  const info = await api.getPathInfo(path).catch(() => null);
  if (info?.isDir) {
    await openFolder(info.path);
    return;
  }
  const filePath = info?.path ?? path;
  if (useWorktreeStore.getState().activeWorktreePath === null) {
    await openFileFromHome(filePath, location);
    return;
  }
  dispatchOpenFile(filePath, location);
}

function openFileFromHome(path: string, location: FileLocation | undefined): Promise<void> {
  return inOrder(async () => {
    await whenProjectsLoaded();
    const { projects } = useProjectStore.getState();
    const owner = deriveOwningWorktree(path, projects, useWorktreeStore.getState().byProject);
    if (!owner) {
      showToast("Open a project before opening other files");
      return;
    }
    await openInWorktree(owner, { kind: "file", path, ...(location ? { location } : {}) });
  });
}
