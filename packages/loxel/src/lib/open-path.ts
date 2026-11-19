import * as api from "@/api/client";
import { localServerId } from "@/api/local-server";
import type { PanelOpenOptions } from "@/api/panel-placement-model";
import {
  type ServerId,
  type WorktreeRef,
  worktreeRef,
  sameOptionalWorktreeRef,
} from "@/api/worktree-ref";
import type {
  InboxOpenMessage,
  OpenFilePanel,
  OpenRequestMessage,
  OpenTerminalPanel,
} from "@/api/ws-protocol";
import { showToast } from "@/components/ui/toast";
import { queryKeys } from "@/queries/query-keys";
import { getQueryScope } from "@/queries/use-scope";
import { queryClient } from "@/query-client";
import { layoutKeyOf } from "@/store/active-worktree";
import {
  type ListedProject,
  deriveProject,
  projectRef,
  useProjectStore,
  whenProjectsLoaded,
} from "@/store/projects";
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

/**
 * The projects `server` lists. A path an open names is on the server it came from, so only its
 * projects can hold it: another server may hold the same path.
 */
function projectsOf(server: ServerId): ListedProject[] {
  return useProjectStore.getState().projects.filter((project) => project.server === server);
}

/** The worktree of `server` holding `path`, if one in this window's lists does. */
function owningWorktree(server: ServerId, path: string): WorktreeRef | null {
  const owner = deriveOwningWorktree(
    path,
    projectsOf(server),
    useWorktreeStore.getState().byProject,
  );
  return owner === null ? null : worktreeRef(server, owner);
}

/** The active worktree if it is on `server`, the one whose Others an outside path opens in. */
function activeWorktreeOn(server: ServerId): WorktreeRef | null {
  const { activeWorktree } = useWorktreeStore.getState();
  return activeWorktree?.server === server ? activeWorktree : null;
}

/**
 * The open inbox requests this window has had, by id (a server-made UUID): the server whose inbox
 * holds each, which is told when the window is done with it, and whether it is.
 */
const inboxOpens = new Map<string, { server: ServerId; done: boolean }>();

function inboxOpenDone(inboxId: string): void {
  const open = inboxOpens.get(inboxId);
  // Placed, here or in another window.
  if (!open || open.done) return;
  open.done = true;
  api.wsClientOf(open.server).send({ type: "inbox_open_done", inboxId });
}

/**
 * A window placed the panel of `server`'s inbox request `inboxId`: unless this one did, the panel
 * queued for it here is not placed. Sent to every window, this one included.
 */
export function dropInboxOpen(server: ServerId, inboxId: string): void {
  const open = inboxOpens.get(inboxId);
  if (open?.server === server) open.done = true;
}

/**
 * Open a request the server kept in its open inbox while no window was connected. The server keeps
 * it until a window is done with it: once its panel is placed, which for a panel queued in a
 * worktree not shown is when the user goes there. An open that fails here is left to the other
 * windows.
 * A request this window already had (the server sends them again after a reconnect) is not opened
 * twice, but done with again, in case the server missed that. `server` sent it.
 */
export async function openFromInbox(
  server: ServerId,
  inboxId: string,
  message: InboxOpenMessage,
): Promise<void> {
  const known = inboxOpens.get(inboxId);
  if (known !== undefined) {
    if (known.done) api.wsClientOf(known.server).send({ type: "inbox_open_done", inboxId });
    return;
  }
  inboxOpens.set(inboxId, { server, done: false });
  // Open here: done. A failed open leaves it to the other windows, or to its expiry.
  if ((await openRequest(server, message, inboxId)) === false) inboxOpenDone(inboxId);
}

/**
 * Open what `POST /api/open` on `server` sent; resolves to true when its panel is queued for
 * later, false when it is open, and undefined when it could not be opened.
 */
export function openRequest(
  server: ServerId,
  message: OpenRequestMessage,
  inboxId?: string,
): Promise<boolean | undefined> {
  switch (message.type) {
    case "open_file":
      return openFile(server, message.data, inboxId);
    case "open_folder":
      return openFolder(server, message.data.path);
    case "open_terminal":
      return openTerminal(server, message.data, inboxId);
    case "open_url":
      return openUrl(server, message.wtPath, message.data, inboxId);
    default: {
      const _exhaustive: never = message;
      throw new Error(`Unknown open request: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Show a folder of `server` in the project files panel. A folder inside a worktree is revealed in
 * that worktree, switching to it if needed; any other folder is opened in the active worktree's
 * Others section, if that worktree is on `server`.
 */
export async function openFolder(server: ServerId, rawPath: string): Promise<false> {
  await inOrder(() => revealFolder(server, rawPath));
  return false;
}

async function revealFolder(server: ServerId, rawPath: string): Promise<void> {
  await whenProjectsLoaded();
  const path = rawPath.replace(/(.)\/+$/, "$1");
  const { switchWorktree } = useWorktreeStore.getState();
  const activeWorktree = activeWorktreeOn(server);

  const owner = owningWorktree(server, path);
  if (owner) {
    if (sameOptionalWorktreeRef(owner, activeWorktree)) {
      showPanel("projectFiles");
    } else {
      await switchWorktree(owner);
      showPanelAfterLayoutRestore("projectFiles");
    }
    // The switch sets the active worktree synchronously, so this targets the owner's store.
    getCurrentWorktreeUI().getState().setPendingReveal({ path, expand: true });
    return;
  }

  const project = deriveProject(path, projectsOf(server));
  if (project) {
    showToast(`${path} is inside ${project.name} but not in any of its worktrees`);
    return;
  }
  if (!activeWorktree) {
    showToast("Open a project before opening other folders");
    return;
  }
  const { activeProject } = getQueryScope();

  try {
    await api.addExternalFolder(activeWorktree.path, path);
  } catch (err) {
    log.error("Failed to open folder", { error: err instanceof Error ? err : undefined, path });
    showToast(err instanceof Error ? err.message : "Failed to open folder");
    return;
  }
  await queryClient.invalidateQueries({
    queryKey: queryKeys.externalFiles(activeProject, activeWorktree),
  });
  showPanel("projectFiles");
  getWorktreeUI(activeWorktree).getState().setPendingReveal({ path, expand: true });
}

/**
 * Open a file of `server` sent from outside the window (`loxel <file>`, Finder), in the worktree
 * named by `worktreePath` if any. Otherwise a file inside a worktree of `server` opens in that
 * worktree, switching to it if needed, and any other file in the active worktree's Others section
 * if that is on `server`. `placement` is resolved in that worktree's layout once it is mounted.
 */
export function openFile(
  server: ServerId,
  { filePath: path, worktreePath, ...options }: OpenFilePanel,
  inboxId?: string,
): Promise<boolean | undefined> {
  return inOrder(async () => {
    await whenProjectsLoaded();
    if (worktreePath) await refreshIfUnlisted(server, worktreePath);

    const target =
      (worktreePath ? worktreeRef(server, worktreePath) : null) ??
      owningWorktree(server, path) ??
      activeWorktreeOn(server);
    if (!target) {
      showToast("Open a project before opening other files");
      return undefined;
    }

    return openInWorktree(target, { kind: "file", path, ...options, inboxId });
  });
}

/**
 * Open a terminal sent from outside the window (`loxel terminal`, the quickstart's command field).
 * `server` has already started its shell and picked its worktree, or Home (null); the panel goes
 * there, switching to the worktree if the open has focus.
 */
export function openTerminal(
  server: ServerId,
  terminal: OpenTerminalPanel,
  inboxId?: string,
): Promise<boolean | undefined> {
  return inOrder(async () => {
    await whenProjectsLoaded();
    const { worktreePath } = terminal;
    if (worktreePath) await refreshIfUnlisted(server, worktreePath);
    const target = worktreePath ? worktreeRef(server, worktreePath) : null;
    return openInWorktree(target, { kind: "terminal", terminal, inboxId });
  });
}

/**
 * Open a page sent from outside the window in a browser panel: of `server`'s `worktreePath`
 * (`loxel <url>`), switching to it if the open has focus, or, for a link opened with Loxel as the
 * browser (no worktree), of the active worktree, else of Home.
 */
export function openUrl(
  server: ServerId,
  worktreePath: string | null,
  { url, ...options }: { url: string } & PanelOpenOptions,
  inboxId?: string,
): Promise<boolean | undefined> {
  return inOrder(async () => {
    await whenProjectsLoaded();
    if (worktreePath) await refreshIfUnlisted(server, worktreePath);
    const target = worktreePath
      ? worktreeRef(server, worktreePath)
      : useWorktreeStore.getState().activeWorktree;
    return openInWorktree(target, { kind: "url", url, ...options, inboxId });
  });
}

/**
 * Make sure a worktree the server named is in the store: one created moments ago (`wt add` from a
 * shell) may not be listed yet, so its project's worktrees are refreshed. The server vouched for
 * the worktree, so a failed refresh does not stop the open.
 */
async function refreshIfUnlisted(server: ServerId, worktreePath: string): Promise<void> {
  const { refreshProjectWorktrees } = useWorktreeStore.getState();
  if (owningWorktree(server, worktreePath)?.path === worktreePath) return;
  const project = deriveProject(worktreePath, projectsOf(server));
  if (!project) return;
  await refreshProjectWorktrees(projectRef(project)).catch((err: unknown) => {
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
async function openInWorktree(target: WorktreeRef | null, open: PendingOpen): Promise<boolean> {
  const { activeWorktree, switchWorktree } = useWorktreeStore.getState();
  const isActive = sameOptionalWorktreeRef(target, activeWorktree);
  const ui = getWorktreeUI(target).getState();
  const centerReady = isActive && getCenterApiLayoutKey() === layoutKeyOf(target);
  if (centerReady && ui.pendingOpens.length === 0) {
    dispatchPendingOpen(open);
    return false;
  }
  ui.queueOpen(open);
  const focus = (open.kind === "terminal" ? open.terminal.focus : open.focus) !== false;
  if (focus && target !== null && !isActive) await switchWorktree(target);
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
    if (inboxOpens.get(open.inboxId)?.done !== false) return;
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
 * Open a path of `server` whose type is unknown (e.g. a terminal link): folders go to
 * {@link openFolder}, files to their editor. Missing paths still open an editor, which reports the
 * error. In Home, which shows no worktree's files, a file opens in the worktree holding it,
 * switching there.
 */
export async function openPath(
  server: ServerId,
  path: string,
  location?: FileLocation,
): Promise<void> {
  const info = await api.getPathInfo(path).catch(() => null);
  if (info?.isDir) {
    await openFolder(server, info.path);
    return;
  }
  const filePath = info?.path ?? path;
  if (useWorktreeStore.getState().activeWorktree === null) {
    await openFileFromHome(server, filePath, location);
    return;
  }
  dispatchOpenFile(filePath, location);
}

/**
 * A file link followed in Home: one of Home's own drafts opens there; any other file opens in the
 * worktree holding it, switching there, since Home shows no worktree's files.
 */
function openFileFromHome(
  server: ServerId,
  path: string,
  location: FileLocation | undefined,
): Promise<void> {
  return inOrder(async () => {
    await whenProjectsLoaded();
    // Home's drafts are kept on the window's server.
    const { homeDraftsDir } = useProjectStore.getState();
    if (server === localServerId() && homeDraftsDir && path.startsWith(homeDraftsDir + "/")) {
      dispatchOpenFile(path, location);
      return;
    }
    const projects = projectsOf(server);
    const owner = owningWorktree(server, path);
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
