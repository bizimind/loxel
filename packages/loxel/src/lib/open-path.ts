import * as api from "@/api/client";
import type { PanelOpenOptions } from "@/api/panel-placement-model";
import type {
  InboxOpenMessage,
  OpenFilePanel,
  OpenRequestMessage,
  OpenTerminalPanel,
} from "@/api/ws-protocol";
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
 * Resolves to what the open resolved to, undefined for a failure.
 */
function inOrder<T>(open: () => Promise<T>): Promise<T | undefined> {
  const run = openChain.then(open).catch((err: unknown) => {
    log.error("Failed to open", { error: err instanceof Error ? err : undefined });
    showToast(err instanceof Error ? err.message : "Failed to open");
    return undefined;
  });
  openChain = run.then(() => {});
  return run;
}

/** The open inbox requests this window has had, by id: whether it is done with each. */
const inboxOpens = new Map<string, boolean>();

function inboxOpenDone(inboxId: string): void {
  // Placed, here or in another window.
  if (inboxOpens.get(inboxId) === true) return;
  inboxOpens.set(inboxId, true);
  api.wsClient.send({ type: "inbox_open_done", inboxId });
}

/**
 * A window placed the panel of the inbox request `inboxId`: unless this one did, the panel queued
 * for it here is not placed. Sent to every window, this one included.
 */
export function dropInboxOpen(inboxId: string): void {
  if (inboxOpens.get(inboxId) === false) inboxOpens.set(inboxId, true);
}

/**
 * Open a request the server kept in its open inbox while no window was connected. The server keeps
 * it until a window is done with it: once its panel is placed, which for a panel queued in a
 * worktree not shown is when the user goes there. An open that fails here is left to the other
 * windows.
 * A request this window already had (the server sends them again after a reconnect) is not opened
 * twice, but done with again, in case the server missed that.
 */
export async function openFromInbox(inboxId: string, message: InboxOpenMessage): Promise<void> {
  const done = inboxOpens.get(inboxId);
  if (done !== undefined) {
    if (done) api.wsClient.send({ type: "inbox_open_done", inboxId });
    return;
  }
  inboxOpens.set(inboxId, false);
  // Open here: done. A failed open leaves it to the other windows, or to its expiry.
  if ((await openRequest(message, inboxId)) === false) inboxOpenDone(inboxId);
}

/**
 * Open what `POST /api/open` sent; resolves to true when its panel is queued for later, false
 * when it is open, and undefined when it could not be opened.
 */
export function openRequest(
  message: OpenRequestMessage,
  inboxId?: string,
): Promise<boolean | undefined> {
  switch (message.type) {
    case "open_file":
      return openFile(message.data, inboxId);
    case "open_folder":
      return openFolder(message.data.path);
    case "open_terminal":
      return openTerminal(message.data, inboxId);
    case "open_url":
      return openUrl(message.wtPath, message.data, inboxId);
    default: {
      const _exhaustive: never = message;
      throw new Error(`Unknown open request: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Show a folder in the project files panel. A folder inside a worktree is revealed in that
 * worktree, switching to it if needed; any other folder is opened in the active worktree's Others
 * section.
 */
export async function openFolder(rawPath: string): Promise<false> {
  await inOrder(() => revealFolder(rawPath));
  return false;
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
export function openFile(
  { filePath: path, worktreePath, ...options }: OpenFilePanel,
  inboxId?: string,
): Promise<boolean | undefined> {
  return inOrder(async () => {
    await whenProjectsLoaded();
    if (worktreePath) await refreshIfUnlisted(worktreePath);
    const { projects } = useProjectStore.getState();
    const { activeWorktreePath, byProject } = useWorktreeStore.getState();

    const target =
      worktreePath ?? deriveOwningWorktree(path, projects, byProject) ?? activeWorktreePath;
    if (!target) {
      showToast("Open a project before opening other files");
      return undefined;
    }

    return openInWorktree(target, { kind: "file", path, ...options, inboxId });
  });
}

/**
 * Open a terminal sent from outside the window (`loxel terminal`, the quickstart's command field).
 * The server has already started its shell and picked its worktree, or Home (null); the panel goes
 * there, switching to the worktree if the open has focus.
 */
export function openTerminal(
  terminal: OpenTerminalPanel,
  inboxId?: string,
): Promise<boolean | undefined> {
  return inOrder(async () => {
    await whenProjectsLoaded();
    if (terminal.worktreePath) await refreshIfUnlisted(terminal.worktreePath);
    return openInWorktree(terminal.worktreePath, { kind: "terminal", terminal, inboxId });
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
  inboxId?: string,
): Promise<boolean | undefined> {
  return inOrder(async () => {
    await whenProjectsLoaded();
    if (worktreePath) await refreshIfUnlisted(worktreePath);
    const target = worktreePath ?? useWorktreeStore.getState().activeWorktreePath;
    return openInWorktree(target, { kind: "url", url, ...options, inboxId });
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
 * A null target is Home, which is only targeted while it is the layout shown. Resolves to true when
 * the panel was queued.
 */
async function openInWorktree(target: string | null, open: PendingOpen): Promise<boolean> {
  const { activeWorktreePath, switchWorktree } = useWorktreeStore.getState();
  const layoutKey = target ?? HOME_LAYOUT_KEY;
  const ui = getWorktreeUI(layoutKey).getState();
  const centerReady = target === activeWorktreePath && getCenterApiLayoutKey() === layoutKey;
  if (centerReady && ui.pendingOpens.length === 0) {
    dispatchPendingOpen(open);
    return false;
  }
  ui.queueOpen(open);
  const focus = (open.kind === "terminal" ? open.terminal.focus : open.focus) !== false;
  if (focus && target !== null && target !== activeWorktreePath) await switchWorktree(target);
  return true;
}

/**
 * Create the panel a {@link PendingOpen} describes in the mounted center layout. Creation goes
 * through the typed window events, like every other panel, so this module does not depend on the
 * panel creators. The open inbox request it came from, if any, is done with; one another window
 * placed meanwhile is not placed again.
 */
export function dispatchPendingOpen(open: PendingOpen): void {
  if (open.inboxId) {
    // Placed already: in another window, or here from an earlier copy of the request.
    if (inboxOpens.get(open.inboxId) !== false) return;
    inboxOpenDone(open.inboxId);
  }
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

/**
 * A file link followed in Home: one of Home's own drafts opens there; any other file opens in the
 * worktree holding it, switching there, since Home shows no worktree's files.
 */
function openFileFromHome(path: string, location: FileLocation | undefined): Promise<void> {
  return inOrder(async () => {
    await whenProjectsLoaded();
    const { projects, homeDraftsDir } = useProjectStore.getState();
    if (homeDraftsDir && path.startsWith(homeDraftsDir + "/")) {
      dispatchOpenFile(path, location);
      return;
    }
    const owner = deriveOwningWorktree(path, projects, useWorktreeStore.getState().byProject);
    if (owner) {
      await openInWorktree(owner, { kind: "file", path, ...(location ? { location } : {}) });
      return;
    }
    const project = deriveProject(path, projects);
    if (project) showToast(`${path} is inside ${project.name} but not in any of its worktrees`);
    else if (projects.length > 0) showToast(`${path} is in none of your projects`);
    else showToast("Open a project before opening other files");
  });
}
