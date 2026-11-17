import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import { openDatabase } from "@bizimind/localdb-sdk";
import { listManagedWorktrees, resolveWorktreesDir } from "@bizimind/wt/lib";
import type { ServerWebSocket } from "bun";

import type { StatusInfo, WorktreeEntry } from "@/api/git-models";
import { HOME_KEY } from "@/api/home-model";
import type { DirEntry } from "@/api/project-files-model";
import { BIN_HEADER_SIZE, BIN_MSG_INPUT, parseBinaryHeader } from "@/api/terminal-stream";
import {
  type FileMoveSource,
  LSP_FRESH_SERVER_PARAM,
  type TerminalSpawnTarget,
  type WsClientMessage,
  type WsMessage,
} from "@/api/ws-protocol";
import { newSessionSecret } from "@/app-session";
import { STOPPING_SERVER_WAIT_MS, type ShutdownTerminals } from "@/parent-channel-protocol";
import { TerminalHostPool, currentHostBuildId } from "@/terminal-host";
import { isStorableFavicon } from "@/url-utils";

import { AgentTerminals } from "./agent-terminals";
import { type CliSocket, takeOverSocket } from "./cli-socket";
import { config, getDetachedDir, getHomeDraftsDir, hash12 } from "./config";
import { DetachedFilesService } from "./detached-files-service";
import { endedHostsNotice } from "./ended-hosts-notice";
import { ExternalFilesService } from "./external-files-service";
import {
  ExternalFolderRegistry,
  ExternalFoldersService,
  createExternalFolderStorage,
} from "./external-folders-service";
import { FileOperationsHistory, FileOperationsService } from "./file-operations-service";
import { FileWatcher } from "./file-watcher";
import { FormatService } from "./format-service";
import { getGitRoot, getRefs, getWorktrees, isBareRepo } from "./git-commands";
import { gitExecClient } from "./git-exec-client";
import { GracePeriods } from "./grace-periods";
import { tomlLspManager, worktreeLspManagers, xmlLspManager } from "./language-servers";
import { logger } from "./logger";
import { NodeModulesChanges } from "./node-modules-changes";
import { NotificationStore } from "./notification-store";
import { OpenInbox, deliveredNotices } from "./open-inbox";
import { listenToParent, parentChannelInput } from "./parent-channel";
import { ProjectFilesService } from "./project-files-service";
import { addProject, loadProjects } from "./project-store";
import { isListedWorktree, toWorktreeEntry } from "./project-worktrees";
import { RegisteredWorktrees } from "./registered-worktrees";
import { onRepoTrustStatusChange } from "./repo-trust";
import {
  type Principal,
  type RequestOriginPolicy,
  checkRequest,
  tcpPrincipal,
} from "./request-origin";
import { error } from "./response-helpers";
import { ReviewDb, getGitAuthorName } from "./review-db";
import type { ActiveWindow, RouteContext } from "./routes";
import { handleRequest, versionInfo } from "./routes";
import { SchemaConsent } from "./schema-consent";
import { SchemaDownloads } from "./schema-downloads";
import { SchemaService } from "./schema-service";
import { initSecretStore } from "./secret-store";
import { serverIdentity } from "./server-identity";
import { createServerPerfMonitor } from "./server-perf-monitor";
import {
  externalFolderConflict,
  findOwningProject,
  listOthers,
  worktreeTree,
} from "./server-state";
import type {
  ClientState,
  ProjectState,
  ResolvedFilePath,
  WorktreeLspData,
  WorktreeResources,
  WsData,
} from "./server-state";
import { removeSessionToken, writeSessionToken } from "./session-token";
import { LOGIN_SHELL_ENV_WAIT_MS, onLoginShellEnvChange, resolveLoginShellEnv } from "./shell-env";
import { measureSpawn } from "./spawn-metrics";
import { SERVER_STOP_GRACE_MS } from "./stdio-lsp-manager";
import { getStore, putStore, recoverOrphanLayoutSessions } from "./store-db";
import { stress } from "./stress-detector";
import type { TerminalSink } from "./terminal-fanout";
import type { TerminalSpawnOptions } from "./terminal-manager";
import { TerminalManager } from "./terminal-manager";
import {
  agentTerminalPolicy,
  isNotificationSequenceEnabled,
  terminalSpawnSettings,
} from "./terminal-settings";
import { toolchainEnvs } from "./toolchain-envs";
import { toolchainStatusModules } from "./toolchain-statuses";
import { getCurrentVersion } from "./version";
import { deleteRowsOfMissingWorktrees, deleteWorktreeRows } from "./worktree-rows";
import { WorktreeStatusTracker } from "./worktree-status-tracker";
import { INTERNAL_WORKTREE_PREFIX } from "./worktree-utils";
import { worktreesChangedMessage } from "./ws-messages";
import { YamlLspManager } from "./yaml-lsp-manager";

const log = logger.child("server");

// --- The desktop app's channel ---
// The app's first message is its session secret, which this server waits for before it serves the
// app over TCP (see request-origin.ts). The app stops its server when it quits with a shutdown
// message on its channel, which says what happens to the terminals. The channel closing without
// one, or the server being reparented, means the app crashed or was killed. Set up first, so a
// quit while the server is still starting stops it too.

const PARENT_CHECK_MS = 2000;

/** Set once startup is done, and a shutdown has a server to tear down. */
let serving = false;
/** Set by the first stop that arrives during startup; any later one (the channel closing) is moot. */
let stoppingInStartup = false;
/**
 * Resolved once startup has reached the terminal hosts, with how to leave them: a stop during
 * startup waits for it, so the shells get the fate the app asked for rather than the hosts' grace
 * period.
 */
const terminalHostsReached =
  Promise.withResolvers<(terminals: ShutdownTerminals) => Promise<void>>();
/**
 * How long a stop during startup holds the port while it waits for startup to reach the terminal
 * hosts and leaves them: well within the time a relaunched app waits for it, so the app never
 * gives up on it and fails to launch.
 */
const STARTUP_STOP_WAIT_MS = STOPPING_SERVER_WAIT_MS - 5000;

/**
 * Stop the server as the app asks, or once the app is gone. One still starting has nothing else to
 * tear down: it leaves the terminal hosts as asked, once startup has reached them, and exits. Gone
 * without a word (`drop`), it exits at once, and the hosts it reached take the closed connections
 * as a crash, keeping the shells for the grace period.
 */
function leaveWithApp(terminals: TerminalsOnShutdown): void {
  if (stoppingInStartup) return;
  if (serving) {
    shutdown(0, terminals);
    return;
  }
  stoppingInStartup = true;
  log.info(`Stopping before startup finished (terminals: ${terminals})`);
  const hostsLeft =
    terminals !== "drop" && holdPortWhileStopping()
      ? Promise.race([
          terminalHostsReached.promise.then((leave) => leave(terminals)),
          Bun.sleep(STARTUP_STOP_WAIT_MS),
        ])
      : Promise.resolve();
  void hostsLeft
    .catch((err: unknown) => log.error("Could not leave the terminal hosts", { error: err }))
    .finally(() => {
      logger.shutdown();
      process.exit(0);
    });
}

/**
 * Take the port until exit, answering only that this server is shutting down: an app relaunched
 * meanwhile then waits for it, rather than starting a server that would take the terminal hosts
 * while this one leaves them. False when another server has the port, and with it the hosts,
 * which this one must then leave alone.
 */
function holdPortWhileStopping(): boolean {
  try {
    Bun.serve({
      port: config.port,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new URL(req.url).pathname === "/api/version"
          ? Response.json(versionInfo(true))
          : new Response("Shutting down", { status: 503 }),
    });
    return true;
  } catch (err) {
    log.warn(`Port ${config.port} is in use; leaving the terminal hosts alone`, { error: err });
    return false;
  }
}

/** The app's session secret, from its channel: requests over TCP must carry it. */
const appSecret = Promise.withResolvers<string>();

if (config.parentPid !== null) {
  listenToParent(parentChannelInput(), {
    session: (secret) => appSecret.resolve(secret),
    shutdown: (terminals) => {
      log.info(`The desktop app asked this server to shut down (terminals: ${terminals})`);
      leaveWithApp(terminals);
    },
    closed: () => {
      log.info("The desktop app that started this server closed its channel, shutting down");
      // As after a crash: the terminals wait out the hosts' grace period for the app to come back.
      leaveWithApp("drop");
    },
  });

  // A backstop for the channel: the app spawns this process directly, so when the app dies the
  // server is reparented (to launchd on macOS), which a reused process ID cannot fake.
  const parentPid = config.parentPid;
  setInterval(() => {
    if (process.ppid === parentPid) return;
    log.info("The desktop app that started this server is gone, shutting down");
    leaveWithApp("drop");
  }, PARENT_CHECK_MS).unref();
} else {
  // Started without the app: its own secret, which its token file gives the tools that drive it.
  appSecret.resolve(newSessionSecret());
}

// --- Multi-project state (no "active" or "focused" concept) ---

const projects = new Map<string, ProjectState>();
const wtResources = new Map<string, WorktreeResources>();
/** Worktrees whose callbacks must stay quiescent while removal is attempted. */
const suspendedWorktrees = new Set<string>();
/** Worktrees nobody subscribes to, whose resources are kept for a subscriber to come back. */
const worktreeGrace = new GracePeriods<string>(config.worktreeGraceMs);

/** Find the project that owns the given path: under its cwd or its worktrees dir. */
export function findProjectForPath(targetPath: string): ProjectState | undefined {
  return findOwningProject(projects.values(), targetPath);
}

/**
 * Resolve an absolute file path to its owning worktree and service type.
 * Worktree files and drafts win over a worktree's Others section, since an open folder may
 * contain other worktrees.
 */
function resolveFilePath(absolutePath: string, preferredWtPath?: string): ResolvedFilePath | null {
  const normalized = resolve(absolutePath);
  // Home's drafts belong to no worktree, so no worktree's resources can resolve them.
  if (normalized.startsWith(homeDrafts.dir + "/")) {
    return { type: "detached", wtPath: HOME_KEY, service: homeDrafts, name: basename(normalized) };
  }
  // A folder can be open in the Others section of several worktrees; the requester's wins.
  const preferred = preferredWtPath ? wtResources.get(preferredWtPath) : undefined;
  const candidates: Array<[string, WorktreeResources]> =
    preferredWtPath && preferred
      ? [[preferredWtPath, preferred], ...[...wtResources].filter(([wt]) => wt !== preferredWtPath)]
      : [...wtResources];
  for (const [wtPath, resources] of candidates) {
    // Check detached files first (more specific path prefix)
    const service = resources.detachedFilesService;
    if (normalized.startsWith(service.dir + "/")) {
      return { type: "detached", wtPath, service, name: basename(normalized) };
    }
    // Check project files
    if (normalized.startsWith(wtPath + "/")) {
      const relativePath = normalized.slice(wtPath.length + 1);
      return {
        type: "tree",
        wtPath,
        resources,
        tree: worktreeTree(wtPath, resources),
        relativePath,
      };
    }
  }
  for (const [wtPath, resources] of candidates) {
    // Check folders opened in the Others section (the root too, e.g. for Reveal in Finder)
    const folder = resources.externalFoldersService.find(normalized);
    if (folder) {
      const relativePath = relative(folder.root, normalized);
      return { type: "tree", wtPath, resources, tree: folder, relativePath };
    }
    // Check external files (individually watched files outside the worktree)
    if (resources.externalFilesService.hasFile(normalized)) {
      return { type: "external", wtPath, resources, absolutePath: normalized };
    }
  }

  return null;
}

/**
 * Remove orphaned temp worktrees left from prior server exits (crashes, SIGKILL, etc.).
 * These are identified by the `INTERNAL_WORKTREE_PREFIX` directory name prefix.
 */
async function pruneOrphanedTempWorktrees(cwd: string): Promise<void> {
  try {
    const worktrees = await getWorktrees(cwd);
    const orphans = worktrees.filter((wt) =>
      basename(wt.path).startsWith(INTERNAL_WORKTREE_PREFIX),
    );
    for (const wt of orphans) {
      try {
        measureSpawn("git worktree", () =>
          Bun.spawnSync(["git", "-C", cwd, "worktree", "remove", "--force", wt.path], {
            stdout: "ignore",
            stderr: "ignore",
          }),
        );
      } catch (err) {
        log.warn(`Failed to remove temp worktree ${wt.path}`, { error: err });
      }
    }
    if (orphans.length > 0) {
      log.info(`Pruned ${orphans.length} orphaned temp worktree(s)`);
    }
  } catch (err) {
    // Non-fatal — don't block startup
    log.warn("Failed to prune orphaned temp worktrees", { error: err });
  }
}

// --- Scoped broadcasting ---

/** Send a message to all subscribers of a specific worktree (with dedup). */
function broadcastToSubscribers(wtPath: string, message: WsMessage) {
  stress.track("broadcast", message.type);
  const resources = wtResources.get(wtPath);
  if (!resources || resources.subscribers.size === 0) return;
  const data = JSON.stringify(message);
  for (const ws of resources.subscribers) {
    ws.send(data);
  }
}

/** Send a message to all subscribers of any worktree under a project. */
function broadcastToProject(projectPath: string, message: WsMessage) {
  stress.track("broadcast", message.type);
  const data = JSON.stringify(message);
  const sent = new Set<ServerWebSocket<WsData>>();
  for (const resources of wtResources.values()) {
    if (resources.projectPath !== projectPath) continue;
    for (const ws of resources.subscribers) {
      if (!sent.has(ws)) {
        ws.send(data);
        sent.add(ws);
      }
    }
  }
}

/** Send a message to ALL connected clients. */
function broadcastAll(message: WsMessage) {
  stress.track("broadcast", message.type);
  const data = JSON.stringify(message);
  for (const client of clients.keys()) {
    client.send(data);
  }
}

/**
 * Where a terminal's shell starts and the `LOXEL_*` variables it gets, from a `terminal_attach`
 * request or a `loxel terminal` open. Applied only when the session is spawned.
 */
function terminalSpawnTarget(
  msg: TerminalSpawnTarget,
): Pick<
  TerminalSpawnOptions,
  "cwd" | "worktreePath" | "windowId" | "envOverrides" | "activatePythonEnv"
> {
  const envOverrides: Record<string, string> = { LOXEL: "1", LOXEL_SOCKET: config.cliSocketPath };
  // A Home terminal has no worktree: the `loxel` CLI then sends its pages to the window.
  if (msg.worktreePath) envOverrides.LOXEL_WORKTREE = msg.worktreePath;
  if (msg.windowId) envOverrides.LOXEL_WINDOW_ID = msg.windowId;
  // Tells Loxel which terminal an agent's `loxel terminal` came from.
  envOverrides.LOXEL_TERMINAL_ID = msg.id;

  // A persisted cwd (`loxel terminal --cwd`) may be gone by the time the panel respawns, e.g.
  // after a server restart; start in the worktree then rather than failing the attach.
  let cwd = msg.cwd;
  if (msg.worktreePath && msg.worktreePath !== cwd && !existsSync(cwd)) {
    log.warn("Terminal cwd is gone, starting in the worktree", { terminalId: msg.id, cwd });
    cwd = msg.worktreePath;
  }
  return {
    cwd,
    worktreePath: msg.worktreePath,
    windowId: msg.windowId,
    envOverrides,
    activatePythonEnv: msg.activatePythonEnv,
  };
}

function sendTo(ws: ServerWebSocket<WsData>, message: WsMessage) {
  ws.send(JSON.stringify(message));
}

/** The app client whose window was focused most recently (reported by the client). */
let lastFocusedClient: ServerWebSocket<WsData> | null = null;

/**
 * The sockets of the window the user is working in: the window `windowId` names (the CLI ran in
 * one of its terminals), otherwise the most recently focused window. Empty when no window is
 * connected.
 */
function activeWindowSockets(windowId: string | null): ServerWebSocket<WsData>[] {
  const named = windowId
    ? [...clients].filter(([, state]) => state.windowId === windowId).map(([ws]) => ws)
    : [];
  const fallback = lastFocusedClient ?? clients.keys().next().value;
  return named.length > 0 ? named : fallback ? [fallback] : [];
}

/** Deliver a request to the window the user is working in. Returns false when there is none. */
function sendToActiveWindow(windowId: string | null, message: WsMessage): boolean {
  const targets = activeWindowSockets(windowId);
  for (const ws of targets) sendTo(ws, message);
  return targets.length > 0;
}

/**
 * Hand the open inbox to a window that just said hello, the first after a time with none. Each
 * request opens as it would have then, focus included, and one notification per worktree says what
 * opened: a panel opened without focus waits unseen in its worktree.
 */
function deliverInbox(ws: ServerWebSocket<WsData>): void {
  const entries = openInbox.takeAll();
  if (entries.length === 0) return;
  for (const { message } of entries) sendTo(ws, message);
  for (const { worktreePath, title, body } of deliveredNotices(entries)) {
    const notification = notificationStore.add({
      source: { kind: "inbox", worktreePath },
      title,
      ...(body ? { body } : {}),
      urgency: "normal",
    });
    broadcastAll({ type: "notification_added", data: notification });
  }
  log.info(`Delivered ${entries.length} open(s) queued while no window was connected`);
}

/**
 * Drop the queued terminals that did not outlive the last server: a panel for one would only show
 * a new shell. Only once every terminal host has listed its sessions: one that did not answer at
 * startup may still hold them, and is adopted once it does.
 */
function dropGoneQueuedTerminals(): void {
  if (!terminalHosts.sessionsKnown) return;
  openInbox.dropWhere(
    ({ message }) =>
      message.type === "open_terminal" && !terminalManager.get(message.data.terminalId),
  );
}

/** The terminal's session is gone: a panel for it would only show a new shell. */
function dropQueuedTerminal(id: string): void {
  openInbox.dropWhere(
    ({ message }) => message.type === "open_terminal" && message.data.terminalId === id,
  );
}

/** The window {@link sendToActiveWindow} delivers to, or null when no window is connected. */
function activeWindow(windowId: string | null): ActiveWindow | null {
  const [ws] = activeWindowSockets(windowId);
  const state = ws ? clients.get(ws) : undefined;
  if (!state) return null;
  return { windowId: state.windowId ?? null, worktreePath: state.shownWorktree ?? null };
}

/**
 * Send `message` to every window showing `wtPath`, except the one the user is working in among
 * them, which gets `primary`: the window `windowId` names, else the most recently focused one, else
 * any of them. A window that left the worktree can stay subscribed until its saves finish, and does
 * not count. Returns false when no window shows it.
 */
function sendToWorktreeWindows(
  wtPath: string,
  windowId: string | null,
  message: WsMessage,
  primary: WsMessage,
): boolean {
  const showing = [...(wtResources.get(wtPath)?.subscribers ?? [])].filter(
    (ws) => clients.get(ws)?.shownWorktree === wtPath,
  );
  const named = windowId ? showing.find((ws) => clients.get(ws)?.windowId === windowId) : undefined;
  const focused = showing.find((ws) => ws === lastFocusedClient);
  const inUse = named ?? focused ?? showing[0];
  for (const ws of showing) sendTo(ws, ws === inUse ? primary : message);
  return showing.length > 0;
}

/** Why a folder cannot be opened in an Others section, given the registered projects. */
function externalFolderConflictFor(folder: string): string | null {
  return externalFolderConflict([...projects.values()], folder, homedir());
}

/** Broadcast a worktree's Others section: its open folders, then its open external files. */
function broadcastOthers(wtPath: string): void {
  const resources = wtResources.get(wtPath);
  if (!resources) return;
  broadcastToSubscribers(wtPath, {
    type: "external_files_changed",
    wtPath,
    data: { entries: listOthers(resources) },
  });
}

// --- Per-worktree status handling ---

/**
 * Ask a subscribed worktree to re-read its git status (the git dir changed). The files service
 * coalesces requests — one pass at a time plus at most one follow-up — and delivers the result
 * to {@link publishWorktreeStatus}; nothing here runs git itself.
 */
function requestStatusRefresh(wtPath: string): void {
  const resources = wtResources.get(wtPath);
  if (!resources || suspendedWorktrees.has(wtPath)) return;
  stress.track("status-event", wtPath);
  void resources.filesService.refreshGitStatus();
}

/** Broadcast a fresh status snapshot read by a subscribed worktree's files service. */
function publishWorktreeStatus(wtPath: string, service: ProjectFilesService, status: StatusInfo) {
  const resources = wtResources.get(wtPath);
  // Resources replaced or torn down while the pass ran, or removal in progress.
  if (resources?.filesService !== service || suspendedWorktrees.has(wtPath)) return;
  broadcastToSubscribers(wtPath, { type: "status_changed", wtPath, data: status });
  projects.get(resources.projectPath)?.worktreeStatuses.update(wtPath, status);
}

/** A worktree's status as its watchers keep it, when it is subscribed and not being removed. */
function liveWorktreeStatus(projectPath: string, wtPath: string): StatusInfo | undefined {
  const resources = wtResources.get(wtPath);
  if (!resources || resources.projectPath !== projectPath || suspendedWorktrees.has(wtPath)) {
    return undefined;
  }
  return resources.filesService.getStatusSnapshot() ?? undefined;
}

function projectHasSubscribers(projectPath: string): boolean {
  for (const resources of wtResources.values()) {
    if (resources.projectPath === projectPath && resources.subscribers.size > 0) return true;
  }
  return false;
}

// --- Worktree resource factories ---

function createWorktreeWatcher(wtPath: string): FileWatcher {
  return new FileWatcher({
    gitRoot: wtPath,
    allowedEvents: new Set(["status"]),
    onEvent: (event) => {
      if (event === "status") requestStatusRefresh(wtPath);
    },
    debounceMs: 150,
  });
}

/** Tell a worktree's subscribers that a directory of one of its trees changed. */
function broadcastDirChanged(wtPath: string, dir: string, entries: DirEntry[]): void {
  broadcastToSubscribers(wtPath, { type: "files_dir_changed", wtPath, data: { dir, entries } });
}

/**
 * Tell a worktree's subscribers that a file changed on disk — in its tree, an Others folder, its
 * drafts or its external files. The absolute path is self-identifying, so all share one message.
 */
function broadcastFileChanged(wtPath: string, path: string, nonces: string[]): void {
  broadcastToSubscribers(wtPath, { type: "file_content_changed", wtPath, data: { path, nonces } });
}

/** Tell a worktree's subscribers that a file an editor has open was renamed or moved. */
function broadcastFileMoved(
  wtPath: string,
  oldPath: string,
  newPath: string,
  source: FileMoveSource,
): void {
  broadcastToSubscribers(wtPath, {
    type: "file_moved",
    wtPath,
    data: { oldPath, newPath, source },
  });
}

/** Folders open in Others sections, shared by every worktree listing them. */
const externalFolderRegistry = new ExternalFolderRegistry({
  onDirChanged: (worktrees, dir, entries) => {
    for (const wtPath of worktrees) broadcastDirChanged(wtPath, dir, entries);
  },
  onFileChanged: (worktrees, path, nonces) => {
    for (const wtPath of worktrees) broadcastFileChanged(wtPath, path, nonces);
  },
  onFileMoved: (worktrees, oldPath, newPath, source) => {
    for (const wtPath of worktrees) broadcastFileMoved(wtPath, oldPath, newPath, source);
  },
});

/**
 * Home's drafts (plans made with no worktree active): always running, since Home belongs to no
 * worktree subscription, and reported to every window, any of which may show Home.
 */
const homeDrafts = new DetachedFilesService(
  getHomeDraftsDir(),
  (entries) => {
    broadcastAll({ type: "detached_files_changed", wtPath: HOME_KEY, data: { entries } });
  },
  (path, nonces) => {
    broadcastAll({ type: "file_content_changed", wtPath: HOME_KEY, data: { path, nonces } });
  },
);

function createDetachedFilesService(cwd: string, wtPath: string): DetachedFilesService {
  const dir = getDetachedDir(cwd, wtPath);
  return new DetachedFilesService(
    dir,
    (entries) => {
      broadcastToSubscribers(wtPath, { type: "detached_files_changed", wtPath, data: { entries } });
    },
    (path, nonces) => broadcastFileChanged(wtPath, path, nonces),
  );
}

function notifyLspWatchedFiles(wtPath: string, paths: string[]): void {
  for (const manager of worktreeLspManagers) manager.notifyWatchedFilesChanged(wtPath, paths);
}

function createFilesService(
  wtPath: string,
  nodeModulesChanges: NodeModulesChanges,
): ProjectFilesService {
  const service: ProjectFilesService = new ProjectFilesService(
    wtPath,
    (dir, entries) => broadcastDirChanged(wtPath, dir, entries),
    (filePath, nonces) => broadcastFileChanged(wtPath, filePath, nonces),
    (status) => publishWorktreeStatus(wtPath, service, status),
    {
      onFileMoved: (oldPath, newPath, source) =>
        broadcastFileMoved(wtPath, oldPath, newPath, source),
      onPathsChanged: (paths) => notifyLspWatchedFiles(wtPath, paths),
      onIgnoredPathChanged: (relPath) => {
        nodeModulesChanges.add(relPath);
        for (const manager of worktreeLspManagers) {
          manager.notifyIgnoredPathChanged?.(wtPath, relPath);
        }
      },
    },
  );
  return service;
}

// --- Subscription management ---

/**
 * Tell a new subscriber to refetch the worktree's file queries: whatever it cached was not kept up
 * to date while it was not subscribed (a reload, a reconnect, a look at another worktree). A
 * directory's changes reach it again once it lists that directory again.
 */
function sendFilesResynced(ws: ServerWebSocket<WsData>, wtPath: string, projectPath: string): void {
  sendTo(ws, { type: "worktree_files_resynced", wtPath, projectPath });
}

async function subscribeWorktree(ws: ServerWebSocket<WsData>, wtPath: string): Promise<void> {
  const existing = wtResources.get(wtPath);
  if (existing) {
    // Within its grace period the worktree is adopted as it is, undo history included.
    if (worktreeGrace.cancel(wtPath)) log.info(`Worktree resources adopted: ${wtPath}`);
    existing.subscribers.add(ws);
    const clientState = clients.get(ws);
    if (clientState) clientState.subscribedWorktrees.add(wtPath);
    log.debug(`Client subscribed to ${wtPath} (${existing.subscribers.size} subscribers)`);
    sendFilesResynced(ws, wtPath, existing.projectPath);
    return;
  }

  const project = findProjectForPath(wtPath);
  if (!project) {
    sendTo(ws, { type: "error", message: `No project found for path: ${wtPath}` });
    return;
  }

  if (project.isBare && wtPath === project.cwd) {
    sendTo(ws, { type: "error", message: "Cannot subscribe to bare repo root" });
    return;
  }

  log.info(`Creating worktree resources for ${wtPath}`);

  // A linked worktree keeps its own index/HEAD under <common>/worktrees/<name>, which the
  // project-level watcher deliberately ignores, so it needs a status watcher of its own. That
  // holds for regular repos too; only a regular repo's root is already covered by the project.
  let worktreeWatcher: FileWatcher | null = null;
  if (wtPath !== project.cwd) {
    worktreeWatcher = createWorktreeWatcher(wtPath);
    await worktreeWatcher.start();
  }

  const nodeModulesChanges = new NodeModulesChanges(wtPath, (paths) =>
    notifyLspWatchedFiles(wtPath, paths),
  );
  const filesService = createFilesService(wtPath, nodeModulesChanges);
  await filesService.start();

  const detachedFilesService = createDetachedFilesService(project.cwd, wtPath);
  await detachedFilesService.start();

  const fileOpsHistory = new FileOperationsHistory();
  const fileOpsService = new FileOperationsService(wtPath, {
    history: fileOpsHistory,
    onOperation: () => filesService.beginOperation(),
  });

  const externalFilesService = new ExternalFilesService(
    () => broadcastOthers(wtPath),
    (path, nonces) => broadcastFileChanged(wtPath, path, nonces),
  );
  externalFilesService.start();

  const externalFoldersService = new ExternalFoldersService({
    wtPath,
    registry: externalFolderRegistry,
    history: fileOpsHistory,
    storage: createExternalFolderStorage(wtPath),
    conflict: externalFolderConflictFor,
    onListChanged: () => broadcastOthers(wtPath),
  });
  await externalFoldersService.start();

  const resources: WorktreeResources = {
    projectPath: project.cwd,
    worktreeWatcher,
    filesService,
    nodeModulesChanges,
    fileOpsService,
    fileOpsHistory,
    detachedFilesService,
    externalFilesService,
    externalFoldersService,
    subscribers: new Set([ws]),
    // The status bar's toolchains follow what is created or removed on disk.
    unsubscribeToolchainStatuses: toolchainStatusModules.map(({ toolchain, subscribe }) =>
      subscribe(wtPath, ({ changed }) => {
        if (changed) broadcastToSubscribers(wtPath, { type: toolchain.changedMessage, wtPath });
      }),
    ),
  };

  wtResources.set(wtPath, resources);
  const clientState = clients.get(ws);
  if (clientState) clientState.subscribedWorktrees.add(wtPath);
  log.info(`Worktree resources created: ${wtPath} (1 subscriber)`);
  // Nothing sweeps a project nobody watches, so its cached dirty list may be old by now.
  project.worktreeStatuses.invalidate();

  // Push initial root directory listing so the file tree isn't empty.
  // The client may have already requested GET /api/files before resources existed
  // and cached an empty result (staleTime: Infinity). This WS push overwrites it.
  filesService
    .getDirContents("", wtPath)
    .then((entries) => {
      broadcastToSubscribers(wtPath, {
        type: "files_dir_changed",
        wtPath,
        data: { dir: wtPath, entries },
      });
    })
    .catch(() => {});

  // Push initial detached files listing (same race condition as above).
  broadcastToSubscribers(wtPath, {
    type: "detached_files_changed",
    wtPath,
    data: { entries: detachedFilesService.listFiles() },
  });
  // Same for the Others section, which starts with the folders restored from the last session.
  broadcastOthers(wtPath);
  sendFilesResynced(ws, wtPath, project.cwd);
}

function unsubscribeWorktree(ws: ServerWebSocket<WsData>, wtPath: string): void {
  const resources = wtResources.get(wtPath);
  if (!resources) return;

  // A repeated unsubscribe must not start the grace period again.
  if (!resources.subscribers.delete(ws)) return;
  const clientState = clients.get(ws);
  if (clientState) clientState.subscribedWorktrees.delete(wtPath);

  if (resources.subscribers.size === 0) {
    log.info(`Worktree resources kept for ${config.worktreeGraceMs} ms: ${wtPath}`);
    worktreeGrace.start(wtPath, () => {
      if (wtResources.get(wtPath) === resources) teardownWorktreeResources(wtPath, resources);
    });
  } else {
    log.debug(`Client unsubscribed from ${wtPath} (${resources.subscribers.size} remaining)`);
  }
}

function teardownWorktreeResources(wtPath: string, resources: WorktreeResources): void {
  worktreeGrace.cancel(wtPath);
  suspendedWorktrees.delete(wtPath);
  resources.worktreeWatcher?.stop();
  resources.filesService.stop();
  resources.nodeModulesChanges.dispose();
  resources.fileOpsService.dispose();
  resources.detachedFilesService.stop();
  resources.externalFilesService.stop();
  resources.externalFoldersService.stop();
  for (const unsubscribe of resources.unsubscribeToolchainStatuses) unsubscribe();
  formatService.invalidateCache(wtPath);
  wtResources.delete(wtPath);
  log.info(`Worktree resources torn down: ${wtPath}`);
}

/** Follow a `worktrees` event: what was removed or moved, by whatever did it. */
async function reconcileWorktrees(project: ProjectState): Promise<void> {
  const { removed, moved } = await project.registeredWorktrees.refresh();
  if (projects.get(project.cwd) !== project) return;

  for (const wtPath of removed) {
    log.info(`Worktree removed, cleaning up: ${wtPath}`);
    completeWorktreeRemoval(wtPath, config.removedWorktreeTerminalDelayMs);
  }
  for (const { from, to } of moved) {
    log.info(`Worktree moved: ${from} -> ${to}`);
    terminalManager.retargetWorktree(from, to);
    agentTerminals.moveWorktree(from, to);
    releaseWorktreeResources(from);
  }
  // Its directory is gone but nothing says it was removed (deleted by hand, say). Nothing is lost by
  // this: it comes back with the directory. A removal in progress resumes the same services if git
  // refuses, so those are left alone.
  for (const [wtPath, resources] of [...wtResources]) {
    if (resources.projectPath !== project.cwd || existsSync(wtPath)) continue;
    if (!suspendedWorktrees.has(wtPath)) releaseWorktreeResources(wtPath);
  }
}

/** Delete what language servers keep outside a worktree that no longer exists. */
function forgetWorktreeInLanguageServers(wtPath: string): void {
  for (const manager of worktreeLspManagers) manager.forgetWorktree?.(wtPath);
}

/** Stop serving a worktree path that no longer exists. */
function releaseWorktreeResources(wtPath: string): void {
  for (const manager of worktreeLspManagers) manager.stopWaitingSessions?.(wtPath);
  forgetWorktreeInLanguageServers(wtPath);
  const resources = wtResources.get(wtPath);
  if (!resources) return;
  for (const ws of resources.subscribers) {
    clients.get(ws)?.subscribedWorktrees.delete(wtPath);
  }
  teardownWorktreeResources(wtPath, resources);
}

/**
 * Everything a removed worktree leaves behind, whichever way it was removed: in the app, after
 * `executeRemove` returned, or by `wt` or `git` anywhere else, on the event that follows. Runs only
 * once the worktree is unregistered, and running it twice is harmless, since an in-app removal also
 * causes that event. `terminalDelayMs` is for a removal seen from outside the app, which may be
 * running in one of these terminals with its branch still to delete, or a command chained after it.
 */
function completeWorktreeRemoval(wtPath: string, terminalDelayMs = 0): void {
  releaseWorktreeResources(wtPath);
  terminalManager.endWorktreeSessions(wtPath, terminalDelayMs, (id) => {
    forgetTerminal(id);
    // Anything it raised during the delay; the rest went with the worktree.
    if (notificationStore.dismissByPanel(id)) {
      broadcastAll({ type: "notification_panel_dismissed", panelId: id });
    }
  });
  forgetWorktreeNotifications(wtPath);
  deleteWorktreeRows(wtPath);
}

/**
 * Dismiss what a removed worktree's panels raised, drop the opens and agents' terminals waiting for
 * it, and forget that its agents' terminals always run.
 */
function forgetWorktreeNotifications(wtPath: string): void {
  const { panelIds, inboxIds } = notificationStore.dismissByWorktree(wtPath);
  for (const panelId of panelIds) broadcastAll({ type: "notification_panel_dismissed", panelId });
  for (const id of inboxIds) broadcastAll({ type: "notification_dismissed", id });
  openInbox.dropWhere((entry) => entry.worktreePath === wtPath);
  agentTerminals.dropWorktree(wtPath);
}

/** Pause only filesystem delivery; service caches and tracked external files remain intact. */
async function suspendWorktreeWatchers(wtPath: string): Promise<() => Promise<void>> {
  const resources = wtResources.get(wtPath);
  if (!resources) return async () => {};

  suspendedWorktrees.add(wtPath);
  resources.worktreeWatcher?.stop();
  await Promise.all([
    resources.filesService.pauseWatching(),
    resources.detachedFilesService.pauseWatching(),
    resources.externalFilesService.pauseWatching(),
  ]);
  log.debug(`Suspended watchers for ${wtPath}`);

  let resumed = false;
  return async () => {
    if (resumed) return;
    resumed = true;
    if (wtResources.get(wtPath) !== resources) return;
    const results = await Promise.allSettled([
      resources.filesService.resumeWatching(),
      resources.detachedFilesService.resumeWatching(),
      resources.externalFilesService.resumeWatching(),
    ]);
    suspendedWorktrees.delete(wtPath);
    const watcherResults = await Promise.allSettled([
      resources.worktreeWatcher?.start() ?? Promise.resolve(),
    ]);
    results.push(...watcherResults);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, `Failed to resume ${wtPath}`);
    // The resync pass ran while still suspended, so its status never reached the tracker.
    projects.get(resources.projectPath)?.worktreeStatuses.invalidate();
    broadcastToSubscribers(wtPath, {
      type: "worktree_files_resynced",
      wtPath,
      projectPath: resources.projectPath,
    });
    log.debug(`Resumed watchers for ${wtPath}`);
  };
}

/** Unsubscribe a client from all worktrees (on disconnect). */
function unsubscribeAllWorktrees(ws: ServerWebSocket<WsData>): void {
  const clientState = clients.get(ws);
  if (!clientState) return;
  for (const wtPath of clientState.subscribedWorktrees) {
    unsubscribeWorktree(ws, wtPath);
  }
}

// --- Project initialization ---

interface InitProjectResult {
  project: ProjectState;
  /** Filtered worktree list (excludes internal loxel temp worktrees). */
  worktrees: WorktreeEntry[];
}

/**
 * Initialize a project: creates repo watcher, opens ReviewDb, resolves metadata.
 * Does NOT create worktree-level services — those are created on subscribe.
 */
async function initializeProject(repoPath: string): Promise<InitProjectResult> {
  const cwd = await getGitRoot(repoPath);
  const isBare = await isBareRepo(cwd);
  log.info(`Initializing ${isBare ? "bare " : ""}project at ${cwd}`);

  const watcher = new FileWatcher({
    gitRoot: cwd,
    // Bare repos have no working tree, so status events are meaningless there.
    // `undefined` allows every event (including "worktrees") for regular repos.
    allowedEvents: isBare ? new Set(["refs", "log", "worktrees"]) : undefined,
    onEvent: async (event) => {
      const project = projects.get(cwd);
      if (!project || watcher !== project.watcher) return;

      if (event === "worktrees") {
        broadcastToProject(cwd, worktreesChangedMessage(cwd));
        await reconcileWorktrees(project).catch((err: unknown) => {
          log.warn("Could not read the worktree list", { projectPath: cwd, error: err });
        });
        project.worktreeStatuses.invalidate();
        return;
      }

      // Status/refs/log — broadcast to subscribers of worktrees under this project
      if (event === "status") {
        for (const [wtPath, resources] of wtResources) {
          if (resources.projectPath === cwd) requestStatusRefresh(wtPath);
        }
      } else if (event === "refs") {
        const refs = await getRefs(cwd);
        broadcastToProject(cwd, { type: "refs_changed", projectPath: cwd, data: refs });
      } else if (event === "log") {
        broadcastToProject(cwd, { type: "log_changed", projectPath: cwd });
        // A commit, checkout or branch move anywhere in the project; the tracker pushes the
        // refreshed list, so clients need not refetch it on `log_changed`.
        project.worktreeStatuses.invalidate();
      }
    },
    debounceMs: 150,
  });

  const [, reviewDb, authorName, , worktreesDir, managed] = await Promise.all([
    pruneOrphanedTempWorktrees(cwd),
    ReviewDb.open(cwd),
    getGitAuthorName(cwd),
    watcher.start(),
    resolveWorktreesDir(cwd),
    listManagedWorktrees(cwd),
  ]);

  const localDb = openDatabase(join(config.stateDir, "localdb", hash12(cwd), "localdb.db"));

  const registeredWorktrees = new RegisteredWorktrees(cwd);
  await registeredWorktrees.refresh();
  const registeredPaths = new Set(managed.map((wt) => wt.path));
  for (const wtPath of deleteRowsOfMissingWorktrees(worktreesDir, registeredPaths)) {
    log.info(`Worktree removed while its project was not watched, deleted its rows: ${wtPath}`);
    forgetWorktreeInLanguageServers(wtPath);
    forgetWorktreeNotifications(wtPath);
  }

  const filteredWorktrees: WorktreeEntry[] = managed
    .filter(isListedWorktree)
    .map((wt) => toWorktreeEntry(wt, null));

  const project: ProjectState = {
    cwd,
    isBare,
    watcher,
    reviewDb,
    localDb,
    authorName,
    worktreesDir,
    registeredWorktrees,
    worktreeStatuses: new WorktreeStatusTracker({
      projectPath: cwd,
      liveStatus: (wtPath) => liveWorktreeStatus(cwd, wtPath),
      hasListeners: () => projectHasSubscribers(cwd),
      onChange: (statuses) =>
        broadcastToProject(cwd, {
          type: "worktree_status_changed",
          projectPath: cwd,
          data: statuses,
        }),
    }),
  };

  projects.set(cwd, project);
  log.info(`Project initialized: ${cwd} (${isBare ? "bare" : "non-bare"})`);

  return { project, worktrees: filteredWorktrees };
}

/** Tear down a project's resources and remove from the projects map. */
function teardownProject(cwd: string): void {
  const project = projects.get(cwd);
  if (!project) return;

  // Tear down any worktree resources under this project
  for (const [wtPath, resources] of wtResources) {
    if (resources.projectPath === cwd) {
      teardownWorktreeResources(wtPath, resources);
    }
  }

  project.watcher.stop();
  project.worktreeStatuses.dispose();
  project.reviewDb.close();
  project.localDb.close();
  projects.delete(cwd);
  log.info(`Project torn down: ${cwd}`);
}

// --- Idle cleanup and auto-shutdown ---

const IDLE_SHUTDOWN_MS = 30_000;
/** Grace period for orphaned terminals to be reattached before they are destroyed. */
const ORPHAN_CLEANUP_MS = 5 * 60_000;
/** Runs while no app client is connected; a connecting client cancels it. */
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

// --- Stable infrastructure ---

const clients = new Map<ServerWebSocket<WsData>, ClientState>();
const logSubscribers = new Set<ServerWebSocket<WsData>>();
/** The terminal hosts, which run every terminal in processes that outlive this server. */
const terminalHosts = new TerminalHostPool({
  stateDir: config.stateDir,
  serverBuild: getCurrentVersion(),
  hostBuildId: await currentHostBuildId(),
  log: logger.child("terminal"),
  perfLog: logger.child("perf"),
});
// A host that did not answer at startup has answered, or is gone: what it holds is known now.
terminalHosts.onSessionsKnown(() => dropGoneQueuedTerminals());
terminalHosts.onEvent((event) => {
  if (event.type === "output") stress.track("pty-output");
});
const terminalManager = new TerminalManager(terminalHosts, {
  isSequenceEnabled: isNotificationSequenceEnabled,
  toolchainEnvs,
  onNotification: (id, meta, payload) => {
    const notification = notificationStore.add({
      source: { kind: "terminal", panelId: id, worktreePath: meta.worktreePath },
      title: payload.title,
      body: payload.body,
      urgency: payload.urgency ?? "normal",
    });
    broadcastAll({ type: "notification_added", data: notification });
  },
  onSessionsChanged: () => broadcastAll({ type: "terminals_changed" }),
  onExit: (id) => {
    // The manager already sent terminal_exit to the attached clients.
    forgetTerminal(id);
    dropQueuedTerminal(id);
  },
});
const notificationStore = new NotificationStore(join(config.stateDir, "notifications.db"));
/** What `loxel` asked to open while no window was connected, for the next window to connect. */
const openInbox = new OpenInbox({ path: join(config.stateDir, "open-inbox.db") });
/** A panel for the terminal is waiting in the inbox: it is not an orphan. */
const queuedTerminal = (id: string) => openInbox.holdsTerminal(id);
const AGENT_TERMINAL_WORKTREES_STORE_KEY = "agent-terminal-worktrees";
/** The terminals agents asked for while the user has to answer, and where they always run. */
const agentTerminals = new AgentTerminals({
  loadAlways: () => getStore(AGENT_TERMINAL_WORKTREES_STORE_KEY),
  saveAlways: (json) => putStore(AGENT_TERMINAL_WORKTREES_STORE_KEY, json),
  onChange: (data) => broadcastAll({ type: "agent_terminals_changed", data }),
});
/** Whether a window with this ID is connected. */
const isWindowConnected = (windowId: string) =>
  [...clients.values()].some((state) => state.windowId === windowId);
/** Longest title or body a browser panel page's notification keeps (main caps them shorter). */
const MAX_BROWSER_NOTIFICATION_TEXT = 4_000;
const schemaService = new SchemaService((from, to) => schemaConsent.mayFollowRedirect(from, to));
const formatService = new FormatService();
const SCHEMA_CONSENT_STORE_KEY = "schema-consent";
const schemaConsent = new SchemaConsent({
  load: () => getStore(SCHEMA_CONSENT_STORE_KEY),
  save: (json) => putStore(SCHEMA_CONSENT_STORE_KEY, json),
  onStateChanged: (data) => {
    tomlLspManager.setTrustedHosts(schemaConsent.chosenHosts());
    broadcastAll({ type: "schema_consent_changed", data });
  },
  onDecision: (change) => {
    void (change === "revoked"
      ? schemaDownloads.onRevoked()
      : schemaDownloads.onTrusted(change.trusted));
  },
});
const schemaDownloads = new SchemaDownloads({
  tombiCacheDir: config.tombiSchemaCacheDir,
  lemminxWorkDir: config.lemminxWorkDir,
  fetchText: (url) => schemaService.fetchText(url),
  request: (url) => schemaConsent.request(url),
  addReferences: (root, references) => schemaConsent.addReferences(root, references),
  restartServers: () => {
    for (const manager of [yamlLspManager, tomlLspManager, xmlLspManager]) {
      manager.restartSessions("schemas changed; reconnect");
    }
  },
});
tomlLspManager.setTrustedHosts(schemaConsent.chosenHosts());
const yamlLspManager = new YamlLspManager({}, (url) => schemaDownloads.contentFor(url));
// A chosen toolchain reaches everything that shares the worktree's resolution (language servers,
// terminals, format on save, the status bar) without a restart.
for (const { onOverrideChange, refresh } of toolchainStatusModules) onOverrideChange(refresh);
onRepoTrustStatusChange(() => broadcastAll({ type: "repo_trust_changed" }));
const worktreeLspManagerByRoute = new Map(
  worktreeLspManagers.map((manager) => [`/ws/${manager.name}`, manager]),
);

/** The worktree language-server connection a socket is, if it is one. */
function worktreeLspData(ws: ServerWebSocket<WsData>): WorktreeLspData | null {
  return ws.data && "wtPath" in ws.data ? ws.data : null;
}

function handleJsonMessage(ws: ServerWebSocket<WsData>, msg: WsClientMessage) {
  switch (msg.type) {
    case "subscribe_worktree": {
      const state = clients.get(ws);
      if (state) state.shownWorktree = msg.worktreePath;
      subscribeWorktree(ws, msg.worktreePath).catch((err) => {
        log.error("Failed to subscribe to worktree", { wtPath: msg.worktreePath, error: err });
        sendTo(ws, {
          type: "error",
          message: `Subscribe failed: ${err instanceof Error ? err.message : "unknown"}`,
        });
      });
      break;
    }

    case "unsubscribe_worktree": {
      // A switch subscribes to the new worktree before it drops the old one, so this clears the
      // shown worktree only when the window leaves it for none (the worktree was removed).
      const state = clients.get(ws);
      if (state?.shownWorktree === msg.worktreePath) delete state.shownWorktree;
      unsubscribeWorktree(ws, msg.worktreePath);
      break;
    }

    case "subscribe_logs":
      logSubscribers.add(ws);
      // Send a reconciliation snapshot so the client can set its badge to
      // `max(0, total - lastSeenTotal)` — recovers from reconnects and from
      // any delta frames lost while the socket was down.
      sendTo(ws, { type: "log_error_snapshot", total: logger.getSnapshotTotal() });
      break;

    case "unsubscribe_logs":
      logSubscribers.delete(ws);
      break;

    case "close_external_file": {
      const resources = wtResources.get(msg.worktreePath);
      if (resources) {
        resources.externalFilesService.removeFile(msg.filePath);
      }
      break;
    }

    case "register_external_files": {
      const resources = wtResources.get(msg.worktreePath);
      if (resources) {
        for (const filePath of msg.filePaths) {
          // Files inside an open Others folder are already watched by that folder.
          if (resources.externalFoldersService.find(resolve(filePath))) continue;
          resources.externalFilesService.addFile(filePath);
        }
      }
      break;
    }

    case "window_hello": {
      const clientState = clients.get(ws);
      if (!clientState) break;
      clientState.windowId = msg.windowId;
      deliverInbox(ws);
      // What waits for an answer with no window to ask in is asked in this one.
      agentTerminals.windowConnected(msg.windowId, isWindowConnected);
      break;
    }

    case "window_focused":
      lastFocusedClient = ws;
      break;

    case "terminal_attach": {
      const clientState = clients.get(ws);
      if (!clientState) return;

      // Several sockets can be attached to one terminal, each streaming to its own sink; an
      // attach again from this one replaces its earlier sink.
      const previous = clientState.terminals.get(msg.id);
      if (previous) terminalManager.detach(msg.id, previous);
      const sink = createTerminalSink(ws, msg.id);
      clientState.terminals.set(msg.id, sink);

      terminalManager
        .attach(msg.id, sink, {
          ...terminalSpawnTarget(msg),
          cols: msg.cols,
          rows: msg.rows,
          scrollbackLines: msg.scrollbackLines,
          sinceEpoch: msg.sinceEpoch,
          sinceOffset: msg.sinceOffset,
        })
        .catch((err: unknown) => {
          log.error("Failed to attach terminal", { terminalId: msg.id, error: err });
          if (clientState.terminals.get(msg.id) === sink) {
            clientState.terminals.delete(msg.id);
            terminalManager.detach(msg.id, sink);
          }
          // The panel says why, a terminal host that did not answer in time for one.
          const message = err instanceof Error ? err.message : String(err);
          sendTo(ws, { type: "terminal_notice", id: msg.id, notice: "attach_failed", message });
        });
      break;
    }

    case "terminal_detach":
      detachTerminal(ws, msg.id);
      break;

    case "terminal_resize": {
      const sink = clients.get(ws)?.terminals.get(msg.id);
      if (sink) terminalManager.resize(msg.id, sink, msg.cols, msg.rows);
      break;
    }

    case "terminal_ack": {
      const sink = clients.get(ws)?.terminals.get(msg.id);
      if (sink) terminalManager.ack(msg.id, sink, msg.syncOffset, msg.bytes);
      break;
    }

    case "terminal_destroy":
      // The panel has usually detached already (unmount runs before the panel-removed handler).
      // A terminal another window still shows keeps running there; the last one to close ends it.
      detachTerminal(ws, msg.id);
      if (!terminalManager.hasClients(msg.id)) terminalManager.destroy(msg.id);
      break;

    // --- Notifications ---

    case "notification_dismiss": {
      if (notificationStore.dismiss(msg.id)) {
        broadcastAll({ type: "notification_dismissed", id: msg.id });
      }
      break;
    }

    case "notification_dismiss_panel": {
      if (notificationStore.dismissByPanel(msg.panelId)) {
        broadcastAll({ type: "notification_panel_dismissed", panelId: msg.panelId });
      }
      break;
    }

    case "notifications_clear": {
      notificationStore.dismissAll();
      broadcastAll({ type: "notifications_cleared" });
      break;
    }

    case "browser_notification_show": {
      // Main already checked and capped what the page sent; this guards the socket itself.
      if (msg.source.kind !== "browser") break;
      const { faviconUrl, ...source } = msg.source;
      for (const id of notificationStore.dismissReplacedBy(source)) {
        broadcastAll({ type: "notification_dismissed", id });
      }
      const { added, evicted } = notificationStore.addBrowser({
        // The favicon is kept like a bookmark's (every window gets the list), or dropped.
        source:
          typeof faviconUrl === "string" && isStorableFavicon(faviconUrl)
            ? { ...source, faviconUrl }
            : source,
        title: msg.title.slice(0, MAX_BROWSER_NOTIFICATION_TEXT),
        body: msg.body?.slice(0, MAX_BROWSER_NOTIFICATION_TEXT),
        urgency: "normal",
      });
      for (const id of evicted) broadcastAll({ type: "notification_dismissed", id });
      broadcastAll({ type: "notification_added", data: added });
      break;
    }

    default: {
      const _exhaustive: never = msg;
      throw new Error(`Unknown WS client message type: ${String(_exhaustive)}`);
    }
  }
}

function handleBinaryMessage(ws: ServerWebSocket<WsData>, data: Buffer) {
  if (data.byteLength < BIN_HEADER_SIZE) return;

  const { type, terminalId } = parseBinaryHeader(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  );
  if (type !== BIN_MSG_INPUT) return;
  const sink = clients.get(ws)?.terminals.get(terminalId);
  if (sink) terminalManager.write(terminalId, sink, data.subarray(BIN_HEADER_SIZE));
}

/** Detach this socket from terminal `id`; the session keeps running, for any other client too. */
function detachTerminal(ws: ServerWebSocket<WsData>, id: string): void {
  const clientState = clients.get(ws);
  const sink = clientState?.terminals.get(id);
  if (!sink) return;
  clientState?.terminals.delete(id);
  terminalManager.detach(id, sink);
}

/**
 * Detach (not destroy) all terminals this client is attached to.
 * Sessions stay alive so they can be reattached on reconnect.
 */
function detachClientTerminals(ws: ServerWebSocket<WsData>) {
  for (const id of [...(clients.get(ws)?.terminals.keys() ?? [])]) detachTerminal(ws, id);
}

/** A session that ended: no socket is attached to it any more. */
function forgetTerminal(id: string): void {
  for (const clientState of clients.values()) clientState.terminals.delete(id);
}

/** Deliver a terminal session's messages to one socket attached to it. */
function createTerminalSink(ws: ServerWebSocket<WsData>, id: string): TerminalSink {
  return {
    sendState: (state) => sendTo(ws, { type: "terminal_state", ...state }),
    sendOutput: ({ frame }) => ws.send(frame),
    sendExit: (end) => sendTo(ws, { type: "terminal_exit", id, ...end }),
    sendNotice: (notice) => sendTo(ws, { type: "terminal_notice", id, ...notice }),
    sendSize: (size) => sendTo(ws, { type: "terminal_size", id, ...size }),
  };
}

// --- Startup ---

// Take the encryption key from Electron, if it has one, before any secret access.
await initSecretStore();

// Resolve the login shell env for spawned tools (hooks, terminals, language servers) while the
// projects load; serving waits for it below. Toolchains resolved before a capture (with the
// inherited PATH, or an older capture's) resolve again when it changed what they read.
for (const { refreshAll } of toolchainStatusModules) {
  onLoginShellEnvChange((names) => refreshAll(names));
}
const loginShellEnv = resolveLoginShellEnv();

const repoArg = process.argv[2];
const data = await loadProjects();

// If CLI arg provided, ensure it's registered as a project
if (repoArg) {
  const existing = data.projects.find((p) => {
    try {
      return p.path === repoArg || p.path === resolve(repoArg);
    } catch {
      return false;
    }
  });
  if (!existing) {
    const project = await addProject(repoArg);
    data.projects.push(project);
  }
}

// Initialize all projects in parallel — no worktree focus, client subscribes on connect
await homeDrafts.start().catch((err: unknown) => {
  log.error("Failed to start Home's drafts", { error: err });
});
const initResults = await Promise.allSettled(data.projects.map((p) => initializeProject(p.path)));

for (let i = 0; i < initResults.length; i++) {
  const result = initResults[i]!;
  if (result.status === "rejected") {
    log.error(`Failed to initialize project ${data.projects[i]!.path}`, { error: result.reason });
  }
}

// --- Static file serving for production builds ---

function findDistDir(): string | null {
  if (process.env.LOXEL_STATIC_DIR) return process.env.LOXEL_STATIC_DIR;
  const builtCandidate = resolve(import.meta.dir, "..");
  if (existsSync(join(builtCandidate, "index.html"))) return builtCandidate;
  const srcCandidate = resolve(import.meta.dir, "../../dist");
  if (existsSync(join(srcCandidate, "index.html"))) return srcCandidate;
  return null;
}

const distDir = findDistDir();
if (distDir) log.info(`Serving static files from ${distDir}`);

// The Vite dev server (dev:app / dev:client) proxies the renderer, so its origin is only valid
// for a dev server; see request-origin.ts for the full policy.
const requestPolicy = {
  port: config.port,
  viteDevPort: config.viteDevPort,
} satisfies RequestOriginPolicy;

/** What the REST routes may do to server state; see routes.ts. */
const routeContext: RouteContext = {
  broadcastToSubscribers,
  broadcastToProject,
  broadcastAll,
  sendToActiveWindow,
  sendToWorktreeWindows,
  externalFolderConflict: externalFolderConflictFor,
  getProject: (cwd: string) => projects.get(cwd),
  findProjectForPath,
  getWorktreeResources: (wtPath: string) => wtResources.get(wtPath),
  suspendWorktreeWatchers,
  completeWorktreeRemoval,
  resolveFilePath,
  initializeProject,
  teardownProject,
  isShuttingDown: () => shuttingDown,
  resolveSchema: (url, baseDir) => schemaService.resolve(url, baseDir),
  schemaConsent,
  ensureSchemas: (urls) => schemaDownloads.ensure(urls),
  updateYamlSchemas: (schemaMap) => yamlLspManager.updateSchemas(schemaMap),
  updateTomlSchemas: (schemaMap) => tomlLspManager.updateSchemas(schemaMap),
  formatContent: (content, filePath, wtPath, settings) =>
    formatService.format(content, filePath, wtPath, settings),
  getDetectedFormatters: (wtPath) => formatService.getDetectedFormatters(wtPath),
  activeWindow,
  homeDrafts,
  startTerminal: ({ command, ...target }) => {
    const settings = terminalSpawnSettings();
    return terminalManager.ensureSpawned(target.id, {
      ...terminalSpawnTarget({ ...target, activatePythonEnv: settings.activatePythonEnv }),
      // The panel's first attach resizes the PTY to its xterm.
      cols: 80,
      rows: 24,
      scrollbackLines: settings.scrollbackLines,
      command,
    });
  },
  // A window may have connected while the route awaited: it gets the request now, since the inbox
  // goes out only on a window's hello.
  queueForWindow: (message, worktreePath) => {
    if (clients.size > 0 && sendToActiveWindow(null, message)) return "sent";
    return openInbox.add(message, worktreePath) ? "queued" : "full";
  },
  dropQueuedTerminal,
  agentTerminals,
  agentTerminalPolicy,
  listTerminals: async ({ programs }) => {
    const running = terminalManager.running();
    const foreground = programs ? await terminalManager.foregroundProcesses() : {};
    return {
      terminals: running.map(({ id, meta }) => ({
        id,
        worktreePath: meta.worktreePath,
        cwd: meta.cwd,
        otherHostBuild: terminalHosts.runsOnOtherBuild(id),
        ...(Object.hasOwn(foreground, id) ? { program: foreground[id] } : {}),
      })),
    };
  },
};

// A server that cannot have the port must fail before it touches the terminal hosts: taking them
// over would cut the running server off from its terminals. One stopping during startup holds the
// port itself.
try {
  if (!stoppingInStartup) {
    Bun.listen({ hostname: "127.0.0.1", port: config.port, socket: { data: () => {} } }).stop(true);
  }
} catch (err) {
  throw new Error(`Port ${config.port} is in use; not starting`, { cause: err });
}

// Terminals that outlived the previous server are this one's before any client can attach to them.
try {
  const { ended } = await terminalHosts.start((sessions) => terminalManager.adopt(sessions));
  dropGoneQueuedTerminals();
  const notice = endedHostsNotice(ended);
  // Kept in the store, so the first window to connect gets it with notifications_sync.
  if (notice) {
    notificationStore.add({ source: { kind: "server" }, ...notice, urgency: "high" });
  }
} catch (err) {
  log.error("Could not reach the running terminal hosts", { error: err });
}
terminalHostsReached.resolve((terminals) => terminalHosts.disconnectAll(terminals));

// Clients spawn language servers and terminals as soon as they connect, so let the login-shell PATH
// land first, but never let a slow or hung shell config hold up startup (it still applies later).
await Promise.race([loginShellEnv, Bun.sleep(LOGIN_SHELL_ENV_WAIT_MS)]);

// The app sends its secret as soon as it has started this server, so it is here long before
// startup is done. Nothing is served over TCP without it. An app that is gone by now closed the
// channel, which stops this server instead.
const sessionSecret = await appSecret.promise;

// Stopped during startup: the server exits once it has left the hosts, and never serves. Nothing
// from here to `serving = true` waits, so a stop cannot arrive in between.
if (stoppingInStartup) await new Promise<never>(() => {});

// A server the app started keeps the secret to itself, except a demo's, which scripts/demo drives.
// Written before the server listens, so a tool that finds it answering finds the file too.
const writesSessionToken = config.parentPid === null || config.isDemo;
if (writesSessionToken) {
  try {
    writeSessionToken(config.stateDir, sessionSecret);
  } catch (err) {
    // The app still reaches this server; only tools that read the token file cannot.
    log.error("Could not write the session token file", { error: err });
  }
}

/**
 * Listen for the `loxel` CLI, taking the socket over from any older server. Null when that fails:
 * the app still works over TCP, and the user is told the CLI cannot reach it. There is no fallback
 * to the TCP port, which the CLI never uses.
 */
function listenForCli(): CliSocket | null {
  const path = config.cliSocketPath;
  try {
    return takeOverSocket(path, (unix) =>
      Bun.serve({
        unix,
        // No WebSockets: the CLI's routes have none, and checkRequest refuses the others.
        fetch: async (req) =>
          (await serveRequest(req, "cli", () => false)) ?? error("Not a WebSocket server", 400),
      }),
    );
  } catch (err) {
    log.error(`Could not listen on ${path} for the loxel CLI`, { error: err });
    // Kept in the store, so the first window to connect gets it with notifications_sync.
    notificationStore.add({
      source: { kind: "server" },
      title: "The loxel command cannot reach Loxel",
      body: `Loxel could not listen on ${path}: ${err instanceof Error ? err.message : String(err)}`,
      urgency: "high",
    });
    return null;
  }
}

/**
 * Serve a request from either listener: `principal` is decided by the one it arrived on (see
 * request-origin.ts): the loopback port's `app` or `anonymous`, by its session secret, or the CLI
 * socket's `cli`.
 */
async function serveRequest(
  req: Request,
  principal: Principal,
  upgrade: (req: Request, data: WsData) => boolean,
): Promise<Response | undefined> {
  const url = new URL(req.url);

  const admitted = { method: req.method, headers: req.headers, pathname: url.pathname };
  const rejection = checkRequest(admitted, principal, requestPolicy);
  if (rejection) {
    log.warn(`Rejected request: ${rejection.reason}`, { ...rejection.details, path: url.pathname });
    return error(rejection.reason, rejection.status);
  }

  if (url.pathname === "/ws/yaml-lsp") {
    const upgraded = upgrade(req, { type: "yaml-lsp" as const });
    if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 });
    return undefined;
  }

  const worktreeLspManager = worktreeLspManagerByRoute.get(url.pathname);
  if (worktreeLspManager) {
    const wtPath = url.searchParams.get("wt");
    if (!wtPath) return new Response("Missing 'wt' query parameter", { status: 400 });
    const upgraded = upgrade(req, {
      type: worktreeLspManager.name,
      wtPath,
      manager: worktreeLspManager,
      freshServer: url.searchParams.has(LSP_FRESH_SERVER_PARAM),
    });
    if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 });
    return undefined;
  }

  if (url.pathname === "/ws") {
    const upgraded = upgrade(req, { type: "app" as const });
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return undefined;
  }

  // The relaunching app and the CLI poll /api/version while this server shuts down; counting
  // those polls as work to drain would keep the drain's quiet period from ever starting.
  if (url.pathname === "/api/version") return handleRequest(req, routeContext);
  if (url.pathname.startsWith("/api")) {
    return trackApiRequest(() => handleRequest(req, routeContext));
  }

  // Serve static files from dist/ when available (production mode)
  if (distDir) {
    const filePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const resolved = resolve(distDir, filePath);
    if (resolved.startsWith(distDir + "/") || resolved === distDir) {
      const file = Bun.file(resolved);
      if (await file.exists()) return new Response(file);
    }
    return new Response(Bun.file(join(distDir, "index.html")));
  }

  return error("Not found", 404);
}

const server = Bun.serve<WsData>({
  port: config.port,
  hostname: "127.0.0.1",
  fetch: (req, server) =>
    serveRequest(req, tcpPrincipal(req.headers, sessionSecret), (upgraded, data) =>
      server.upgrade(upgraded, { data }),
    ),

  websocket: {
    open(ws) {
      if (ws.data?.type === "yaml-lsp") {
        yamlLspManager.attach(ws);
        return;
      }
      const worktreeLsp = worktreeLspData(ws);
      if (worktreeLsp) {
        worktreeLsp.manager.createSession(ws, worktreeLsp.wtPath, worktreeLsp.freshServer);
        return;
      }
      if (shuttingDown) {
        ws.close(1001, "Server shutting down");
        return;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
        log.info("Idle timer cancelled — client connected");
      }
      clients.set(ws, { terminals: new Map(), subscribedWorktrees: new Set() });
      // First, so the client knows whether this is the server it saw before (see WsClient).
      sendTo(ws, { type: "server_hello", version: getCurrentVersion(), ...serverIdentity });
      sendTo(ws, { type: "notifications_sync", data: notificationStore.getAll() });
      sendTo(ws, { type: "schema_consent_changed", data: schemaConsent.state() });
      sendTo(ws, { type: "agent_terminals_changed", data: agentTerminals.state() });
      log.debug(`Client connected (${clients.size} total)`);
    },

    close(ws) {
      if (ws.data?.type === "yaml-lsp") {
        yamlLspManager.detach(ws);
        return;
      }
      const worktreeLsp = worktreeLspData(ws);
      if (worktreeLsp) {
        worktreeLsp.manager.destroySession(ws);
        return;
      }
      unsubscribeAllWorktrees(ws);
      detachClientTerminals(ws);
      logSubscribers.delete(ws);
      clients.delete(ws);
      if (lastFocusedClient === ws) lastFocusedClient = null;
      // What this window was asking moves to the window in use, or waits for the next one.
      agentTerminals.windowClosed(isWindowConnected, activeWindow(null)?.windowId ?? null);
      log.debug(`Client disconnected (${clients.size} remaining)`);

      if (clients.size === 0 && !idleTimer && !shuttingDown) startIdleTimer();
    },

    message(ws, message) {
      // Shutdown waits for language servers to exit: nothing may start again behind its teardown.
      if (shuttingDown) return;
      if (ws.data?.type === "yaml-lsp") {
        if (typeof message === "string") yamlLspManager.handleMessage(ws, message);
        return;
      }
      const worktreeLsp = worktreeLspData(ws);
      if (worktreeLsp) {
        if (typeof message === "string") worktreeLsp.manager.handleMessage(ws, message);
        return;
      }
      if (typeof message === "string") {
        try {
          const raw: unknown = JSON.parse(message);
          if (typeof raw !== "object" || raw === null || !("type" in raw)) return;
          handleJsonMessage(ws, raw as WsClientMessage);
        } catch (err) {
          log.error("Failed to parse incoming WebSocket message", { error: err });
        }
      } else {
        handleBinaryMessage(ws, message);
      }
    },
  },
});

/** The `loxel` CLI's socket (see cli-socket.ts), or null when this server could not listen there. */
const cliSocket = listenForCli();

// Wire logger broadcast now that the server and broadcastAll are available.
// log_entries is subscription-gated — only clients that sent `subscribe_logs`
// receive full entry batches. log_error_count is always broadcast so the badge
// updates even when no client has the Logs panel open.
logger.setBroadcast((entries) => {
  if (logSubscribers.size === 0) return;
  const data = JSON.stringify({ type: "log_entries", data: entries });
  for (const ws of logSubscribers) {
    ws.send(data);
  }
});
logger.setErrorCountBroadcast((delta) => broadcastAll({ type: "log_error_count", delta }));

// Recover layout-session rows orphaned by previous renderer/server crashes.
// Server start implies no live renderers — any session rows are leftovers.
recoverOrphanLayoutSessions();

// Terminals from before a restart are orphans until their windows reattach: the same rule as when
// the last window closes gives them time to.
if (terminalManager.hasOrphanSessions(queuedTerminal)) startIdleTimer();

log.info(`Server listening on http://${server.hostname}:${server.port}`);
if (cliSocket) log.info(`Listening for the loxel CLI on ${config.cliSocketPath}`);
if (cliSocket && dirname(config.cliSocketPath) !== join(config.stateDir, "run")) {
  log.warn(
    `The state directory is too deep for a socket path; the loxel CLI's socket is in ${config.cliSocketPath}, where the system may purge it after a few days unused`,
  );
}
log.info(`State directory: ${config.stateDir}${config.isDev ? " (dev)" : ""}`);
if (projects.size === 0) log.info("No projects registered, waiting for project selection");

const perfMonitor = createServerPerfMonitor();

const SHUTDOWN_LSP_WAIT_MS = SERVER_STOP_GRACE_MS + 1000;

/**
 * The last app client disconnected. Orphaned sessions get time to be reattached (a window
 * reloading, or waking from sleep) before they are destroyed. A server the desktop app started
 * stays up until the app quits; a standalone one shuts down.
 */
function startIdleTimer(): void {
  const ownedByApp = config.parentPid !== null;
  const hasOrphans = terminalManager.hasOrphanSessions();
  // A server the app owns always arms the cleanup: a terminal still resolving its environment is
  // not an orphan yet, but becomes one when it spawns with no client attached.
  if (hasOrphans || ownedByApp) {
    log.info(
      `No clients remaining, detached terminals have ${ORPHAN_CLEANUP_MS / 1000}s to be reattached`,
    );
    idleTimer = setTimeout(() => {
      idleTimer = null;
      const destroyed = terminalManager.destroyOrphans(queuedTerminal);
      if (destroyed > 0) log.info(`Destroyed ${destroyed} orphaned terminal(s)`);
      if (ownedByApp) return;
      log.info("Idle timeout reached, shutting down");
      shutdown();
    }, ORPHAN_CLEANUP_MS);
    return;
  }
  log.info(`No clients remaining, shutting down in ${IDLE_SHUTDOWN_MS / 1000}s`);
  idleTimer = setTimeout(() => {
    log.info("Idle timeout reached, shutting down");
    shutdown();
  }, IDLE_SHUTDOWN_MS);
}

// --- API requests in flight, drained before shutdown ---

/** Shutdown waits this long without a new API request: a closing window's last writes may still be on their way. */
const DRAIN_QUIET_MS = 300;
/** The longest shutdown waits for API requests, such as a save that is formatting. */
const DRAIN_MAX_MS = 5000;
let apiRequestsInFlight = 0;
let lastApiRequestAt = 0;

async function trackApiRequest(run: () => Promise<Response>): Promise<Response> {
  apiRequestsInFlight++;
  lastApiRequestAt = Date.now();
  try {
    return await run();
  } finally {
    apiRequestsInFlight--;
  }
}

/** Resolves once no API request is in flight or has started for DRAIN_QUIET_MS, or at DRAIN_MAX_MS. */
async function drainApiRequests(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DRAIN_MAX_MS) {
    const quietSince = Math.max(startedAt, lastApiRequestAt);
    if (apiRequestsInFlight === 0 && Date.now() - quietSince >= DRAIN_QUIET_MS) return;
    await Bun.sleep(50);
  }
  if (apiRequestsInFlight > 0) {
    log.warn(`Shutting down with ${apiRequestsInFlight} API request(s) still in flight`);
  } else {
    log.info(`API requests kept arriving for ${DRAIN_MAX_MS / 1000}s, shutting down`);
  }
}

/**
 * What a shutdown does to the terminals: `end` them, as a quit or an idle shutdown does, `keep`
 * them running until a server comes back (Quit and Keep Terminals, Restart Loxel, an update), or
 * `drop` the connections to their hosts as a crash would, so they get the hosts' grace period to
 * be reattached by the next server.
 */
type TerminalsOnShutdown = ShutdownTerminals | "drop";

/**
 * Stop the server: let API requests finish first (saves, store writes, layout promotes), so a quit
 * loses nothing the app already sent, then tear everything down and exit.
 */
function shutdown(exitCode = 0, terminals: TerminalsOnShutdown = "end") {
  if (shuttingDown) return;
  shuttingDown = true;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  log.info("Server shutting down");
  void drainApiRequests().finally(() => tearDown(exitCode, terminals));
}

function tearDown(exitCode: number, terminals: TerminalsOnShutdown) {
  homeDrafts.stop();
  // Teardown all worktree resources
  for (const [wtPath, resources] of wtResources) {
    teardownWorktreeResources(wtPath, resources);
  }

  // Teardown all project resources (also cancels their pending worktree status sweeps)
  for (const cwd of Array.from(projects.keys())) {
    teardownProject(cwd);
  }

  // The hosts must have the disconnect before this process exits, or they take it for a crash.
  const terminalsLeft =
    terminals === "drop"
      ? Promise.resolve(terminalHosts.dropAll())
      : terminalHosts.disconnectAll(terminals);
  formatService.destroy();
  const lspServersStopped = Promise.all(
    [yamlLspManager, ...worktreeLspManagers].map((manager) => manager.destroy()),
  );
  gitExecClient.stop();
  perfMonitor.dispose();
  stress.dispose();
  server.stop();
  // Removes the socket file unless a newer server took it over. Nothing here may keep the process
  // from exiting below.
  try {
    cliSocket?.stop();
  } catch (err) {
    log.warn(`Could not remove ${config.cliSocketPath}`, { error: err });
  }
  try {
    if (writesSessionToken) removeSessionToken(config.stateDir, sessionSecret);
  } catch (err) {
    log.warn("Could not remove the session token file", { error: err });
  }
  // Exiting would cancel the SIGKILL of a server that ignores SIGTERM. Bounded, for a process that
  // not even SIGKILL ends right away (stuck in the kernel).
  void Promise.race([
    Promise.all([lspServersStopped, terminalsLeft]),
    Bun.sleep(SHUTDOWN_LSP_WAIT_MS),
  ]).finally(() => {
    logger.shutdown();
    process.exit(exitCode);
  });
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

// Only now can a shutdown tear the server down: see `leaveWithApp`.
serving = true;

process.on("uncaughtException", (err) => {
  log.error("Uncaught exception, shutting down", { error: err });
  // A crash: the terminals wait out the hosts' grace period for the restarted server.
  shutdown(1, "drop");
});

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection", {
    error: reason instanceof Error ? reason : undefined,
    message: reason instanceof Error ? undefined : String(reason),
  });
});
