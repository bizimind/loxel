import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

import { openDatabase } from "@bizimind/localdb-sdk";
import { listManagedWorktrees, resolveWorktreesDir } from "@bizimind/wt/lib";
import type { ServerWebSocket } from "bun";

import type { StatusInfo, WorktreeEntry } from "@/api/git-models";
import type { DirEntry } from "@/api/project-files-model";
import type { AgentEventPayload, WsClientMessage, WsMessage } from "@/api/ws-protocol";
import {
  BIN_HEADER_SIZE,
  BIN_MSG_INPUT,
  BIN_MSG_OUTPUT,
  encodeBinaryFrame,
  parseBinaryHeader,
} from "@/api/ws-protocol";

import { AgentManager } from "./agent-manager";
import { AstroLspManager } from "./astro-lsp-manager";
import { config, getDetachedDir, hash12 } from "./config";
import { DetachedFilesService } from "./detached-files-service";
import { DockerLspManager } from "./docker-lsp-manager";
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
import { logger } from "./logger";
import { NotificationStore } from "./notification-store";
import { ProjectFilesService } from "./project-files-service";
import { addProject, loadProjects } from "./project-store";
import { PtyManager } from "./pty-manager";
import { PythonLspManager } from "./python-lsp-manager";
import { ReviewDb, getGitAuthorName } from "./review-db";
import { handleRequest } from "./routes";
import { SchemaService } from "./schema-service";
import { initSecretStore } from "./secret-store";
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
  WorktreeResources,
  WsData,
  WorktreeLspType,
} from "./server-state";
import { resolveLoginShellEnv } from "./shell-env";
import { recoverOrphanLayoutSessions } from "./store-db";
import { stress } from "./stress-detector";
import { TerraformLspManager } from "./terraform-lsp-manager";
import { TsLspManager } from "./ts-lsp-manager";
import { WorktreeStatusTracker } from "./worktree-status-tracker";
import { INTERNAL_WORKTREE_PREFIX } from "./worktree-utils";
import { worktreesChangedMessage } from "./ws-messages";
import { XmlLspManager } from "./xml-lsp-manager";
import { YamlLspManager } from "./yaml-lsp-manager";

const log = logger.child("server");

// --- Multi-project state (no "active" or "focused" concept) ---

const projects = new Map<string, ProjectState>();
const wtResources = new Map<string, WorktreeResources>();
/** Worktrees whose callbacks must stay quiescent while removal is attempted. */
const suspendedWorktrees = new Set<string>();

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
  // A folder can be open in the Others section of several worktrees; the requester's wins.
  const preferred = preferredWtPath ? wtResources.get(preferredWtPath) : undefined;
  const candidates: Array<[string, WorktreeResources]> =
    preferredWtPath && preferred
      ? [[preferredWtPath, preferred], ...[...wtResources].filter(([wt]) => wt !== preferredWtPath)]
      : [...wtResources];
  for (const [wtPath, resources] of candidates) {
    // Check detached files first (more specific path prefix)
    const detachedDir = resources.detachedFilesService.dir;
    if (normalized.startsWith(detachedDir + "/")) {
      const name = basename(normalized);
      return { type: "detached", wtPath, resources, name };
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
        Bun.spawnSync(["git", "-C", cwd, "worktree", "remove", "--force", wt.path], {
          stdout: "ignore",
          stderr: "ignore",
        });
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
  stress.track("broadcast", { type: message.type });
  const resources = wtResources.get(wtPath);
  if (!resources || resources.subscribers.size === 0) return;
  const data = JSON.stringify(message);
  for (const ws of resources.subscribers) {
    ws.send(data);
  }
}

/** Send a message to all subscribers of any worktree under a project. */
function broadcastToProject(projectPath: string, message: WsMessage) {
  stress.track("broadcast", { type: message.type });
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
  stress.track("broadcast", { type: message.type });
  const data = JSON.stringify(message);
  for (const client of clients.keys()) {
    client.send(data);
  }
}

function sendTo(ws: ServerWebSocket<WsData>, message: WsMessage) {
  ws.send(JSON.stringify(message));
}

/** The app client whose window was focused most recently (reported by the client). */
let lastFocusedClient: ServerWebSocket<WsData> | null = null;

/**
 * Deliver a request to the window the user is working in: the window `windowId` names (the CLI
 * ran in one of its terminals), otherwise the most recently focused window. Returns false when no
 * window can receive it.
 */
function sendToActiveWindow(windowId: string | null, message: WsMessage): boolean {
  const named = windowId
    ? [...clients].filter(([, state]) => state.windowId === windowId).map(([ws]) => ws)
    : [];
  const fallback = lastFocusedClient ?? clients.keys().next().value;
  const targets = named.length > 0 ? named : fallback ? [fallback] : [];
  for (const ws of targets) sendTo(ws, message);
  return targets.length > 0;
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
  stress.track("status-event", { wtPath });
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

/** Folders open in Others sections, shared by every worktree listing them. */
const externalFolderRegistry = new ExternalFolderRegistry({
  onDirChanged: (worktrees, dir, entries) => {
    for (const wtPath of worktrees) broadcastDirChanged(wtPath, dir, entries);
  },
  onFileChanged: (worktrees, path, nonces) => {
    for (const wtPath of worktrees) broadcastFileChanged(wtPath, path, nonces);
  },
});

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

function createFilesService(wtPath: string): ProjectFilesService {
  const service: ProjectFilesService = new ProjectFilesService(
    wtPath,
    (dir, entries) => broadcastDirChanged(wtPath, dir, entries),
    (filePath, nonces) => broadcastFileChanged(wtPath, filePath, nonces),
    (status) => publishWorktreeStatus(wtPath, service, status),
  );
  return service;
}

// --- Subscription management ---

async function subscribeWorktree(ws: ServerWebSocket<WsData>, wtPath: string): Promise<void> {
  const existing = wtResources.get(wtPath);
  if (existing) {
    existing.subscribers.add(ws);
    const clientState = clients.get(ws);
    if (clientState) clientState.subscribedWorktrees.add(wtPath);
    log.debug(`Client subscribed to ${wtPath} (${existing.subscribers.size} subscribers)`);
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

  const filesService = createFilesService(wtPath);
  await filesService.start();

  const detachedFilesService = createDetachedFilesService(project.cwd, wtPath);
  await detachedFilesService.start();

  const fileOpsHistory = new FileOperationsHistory();
  const fileOpsService = new FileOperationsService(wtPath, { history: fileOpsHistory });

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
    fileOpsService,
    fileOpsHistory,
    detachedFilesService,
    externalFilesService,
    externalFoldersService,
    subscribers: new Set([ws]),
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
}

function unsubscribeWorktree(ws: ServerWebSocket<WsData>, wtPath: string): void {
  const resources = wtResources.get(wtPath);
  if (!resources) return;

  resources.subscribers.delete(ws);
  const clientState = clients.get(ws);
  if (clientState) clientState.subscribedWorktrees.delete(wtPath);

  if (resources.subscribers.size === 0) {
    teardownWorktreeResources(wtPath, resources);
  } else {
    log.debug(`Client unsubscribed from ${wtPath} (${resources.subscribers.size} remaining)`);
  }
}

function teardownWorktreeResources(wtPath: string, resources: WorktreeResources): void {
  suspendedWorktrees.delete(wtPath);
  resources.worktreeWatcher?.stop();
  resources.filesService.stop();
  resources.fileOpsService.dispose();
  resources.detachedFilesService.stop();
  resources.externalFilesService.stop();
  resources.externalFoldersService.stop();
  formatService.invalidateCache(wtPath);
  wtResources.delete(wtPath);
  log.info(`Worktree resources torn down: ${wtPath}`);
}

function reconcileRemovedWorktrees(projectPath: string): void {
  for (const [wtPath, resources] of [...wtResources]) {
    if (resources.projectPath !== projectPath || existsSync(wtPath)) continue;

    log.info(`Worktree removed outside the app, releasing resources: ${wtPath}`);
    completeWorktreeRemoval(wtPath);
  }
}

/** Permanently release a removed worktree after its final project broadcast. */
function completeWorktreeRemoval(wtPath: string): void {
  const resources = wtResources.get(wtPath);
  if (!resources) return;
  for (const ws of resources.subscribers) {
    clients.get(ws)?.subscribedWorktrees.delete(wtPath);
  }
  teardownWorktreeResources(wtPath, resources);
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
        reconcileRemovedWorktrees(cwd);
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

  const filteredWorktrees: WorktreeEntry[] = managed
    .filter((wt) => !basename(wt.path).startsWith(INTERNAL_WORKTREE_PREFIX))
    .map((wt) => ({
      path: wt.path,
      branch: wt.branch,
      commit: wt.head,
      isMain: false,
      createdAt: null,
      wtName: wt.name,
    }));

  const project: ProjectState = {
    cwd,
    isBare,
    watcher,
    reviewDb,
    localDb,
    authorName,
    worktreesDir,
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

// --- Idle auto-shutdown ---

const IDLE_SHUTDOWN_MS = 30_000;
/** Grace period for orphaned terminals to be reattached before cleanup + shutdown. */
const ORPHAN_CLEANUP_MS = 5 * 60_000;
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

// --- Stable infrastructure ---

const clients = new Map<ServerWebSocket<WsData>, ClientState>();
const terminalOwners = new Map<string, ServerWebSocket<WsData>>();
const agentOwners = new Map<string, ServerWebSocket<WsData>>();
const logSubscribers = new Set<ServerWebSocket<WsData>>();
const ptyManager = new PtyManager();
const agentManager = new AgentManager();
const notificationStore = new NotificationStore();
const schemaService = new SchemaService();
const formatService = new FormatService();
const yamlLspManager = new YamlLspManager({});
const tsLspManager = new TsLspManager();
const dockerLspManager = new DockerLspManager();
const terraformLspManager = new TerraformLspManager();
const pythonLspManager = new PythonLspManager();
const astroLspManager = new AstroLspManager();
const xmlLspManager = new XmlLspManager();

function handleJsonMessage(ws: ServerWebSocket<WsData>, msg: WsClientMessage) {
  switch (msg.type) {
    case "subscribe_worktree":
      subscribeWorktree(ws, msg.worktreePath).catch((err) => {
        log.error("Failed to subscribe to worktree", { wtPath: msg.worktreePath, error: err });
        sendTo(ws, {
          type: "error",
          message: `Subscribe failed: ${err instanceof Error ? err.message : "unknown"}`,
        });
      });
      break;

    case "unsubscribe_worktree":
      unsubscribeWorktree(ws, msg.worktreePath);
      break;

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
      if (clientState) clientState.windowId = msg.windowId;
      break;
    }

    case "window_focused":
      lastFocusedClient = ws;
      break;

    case "terminal_create": {
      const clientState = clients.get(ws);
      if (!clientState) return;

      // Register ownership before create — reattach replays scrollback synchronously
      // through the onOutput callback which reads from terminalOwners.
      clientState.terminals.add(msg.id);
      terminalOwners.set(msg.id, ws);

      const envOverrides: Record<string, string> = {
        LOXEL: "1",
        LOXEL_PORT: String(config.port),
        LOXEL_WORKTREE: msg.cwd,
      };
      if (msg.windowId) envOverrides.LOXEL_WINDOW_ID = msg.windowId;

      ptyManager.create(
        msg.id,
        {
          cols: msg.cols,
          rows: msg.rows,
          cwd: msg.cwd,
          scrollbackLines: msg.scrollbackLines,
          envOverrides,
        },
        (id, data) => {
          const owner = terminalOwners.get(id);
          if (owner) owner.send(encodeBinaryFrame(BIN_MSG_OUTPUT, id, data));
        },
        (id, exitCode) => {
          const owner = terminalOwners.get(id);
          if (owner) {
            sendTo(owner, { type: "terminal_exit", id, exitCode });
            clients.get(owner)?.terminals.delete(id);
          }
          terminalOwners.delete(id);
        },
      );
      break;
    }

    case "terminal_resize":
      if (terminalOwners.get(msg.id) === ws) {
        ptyManager.resize(msg.id, msg.cols, msg.rows);
      }
      break;

    case "terminal_destroy":
      if (terminalOwners.get(msg.id) === ws) {
        ptyManager.destroy(msg.id);
        clients.get(ws)?.terminals.delete(msg.id);
        terminalOwners.delete(msg.id);
      }
      break;

    case "agent_create": {
      const existingOwner = agentOwners.get(msg.id);
      if (existingOwner && existingOwner !== ws) {
        agentManager.detach(msg.id);
      }

      agentOwners.set(msg.id, ws);

      const onEvent = (id: string, event: AgentEventPayload, seq: number) => {
        const owner = agentOwners.get(id);
        if (owner) sendTo(owner, { type: "agent_event", id, seq, event });
      };
      const onExit = (id: string, exitCode: number) => {
        const owner = agentOwners.get(id);
        if (owner) sendTo(owner, { type: "agent_exit", id, exitCode });
      };

      // Three distinct paths: reattach existing, create from fork, or create new
      const reconnected = agentManager.reconnectClient(msg.id, onEvent, onExit);
      if (!reconnected) {
        const baseOptions = {
          workspaceRoot: msg.workspaceRoot,
          scopeKey: msg.scopeKey,
          sessionOptions: msg.sessionOptions,
        };
        if (msg.forkedSessionId) {
          agentManager.createFromFork(
            msg.id,
            {
              ...baseOptions,
              forkedSessionId: msg.forkedSessionId,
              forkPointMessageId: msg.forkPointMessageId,
            },
            onEvent,
            onExit,
          );
        } else {
          agentManager.create(msg.id, baseOptions, onEvent, onExit);
        }
      }

      sendTo(ws, { type: "agent_replay_done", id: msg.id });
      break;
    }

    case "agent_request": {
      if (agentOwners.get(msg.id) !== ws) break;
      const sent = agentManager.sendRequest(msg.id, msg.request);
      if (!sent) {
        sendTo(ws, { type: "agent_error", id: msg.id, message: "Session not found or exited" });
      }
      break;
    }

    case "agent_destroy": {
      if (agentOwners.get(msg.id) !== ws) break;
      agentOwners.delete(msg.id);
      agentManager.destroy(msg.id).catch((err: unknown) => {
        log.error(`Failed to destroy agent session ${msg.id.slice(0, 8)}`, { error: err });
      });
      break;
    }

    case "agent_detach": {
      if (agentOwners.get(msg.id) !== ws) break;
      agentOwners.delete(msg.id);
      agentManager.detach(msg.id);
      break;
    }

    case "agent_list": {
      const sessions = agentManager.getSessionsByScope(msg.scopeKey);
      sendTo(ws, { type: "agent_sessions", scopeKey: msg.scopeKey, sessions });
      break;
    }

    // --- Notifications ---

    case "notification_add": {
      const notification = notificationStore.add({
        source: msg.source,
        title: msg.title,
        body: msg.body,
        urgency: msg.urgency ?? "normal",
      });
      broadcastAll({ type: "notification_added", data: notification });
      break;
    }

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
  if (type === BIN_MSG_INPUT) {
    if (terminalOwners.get(terminalId) !== ws) return;
    ptyManager.writeBinary(terminalId, data.subarray(BIN_HEADER_SIZE));
  }
}

/**
 * Detach (not destroy) all terminals owned by this client.
 * Sessions stay alive so they can be reattached on reconnect.
 */
function detachClientTerminals(ws: ServerWebSocket<WsData>) {
  const clientState = clients.get(ws);
  if (!clientState) return;
  ptyManager.detachAll(clientState.terminals);
  for (const id of clientState.terminals) {
    terminalOwners.delete(id);
  }
}

/** Detach (not destroy) all agent sessions owned by this client. */
function detachClientAgents(ws: ServerWebSocket<WsData>) {
  for (const [id, owner] of agentOwners) {
    if (owner === ws) {
      agentManager.detach(id);
      agentOwners.delete(id);
    }
  }
}

// --- Startup ---

// Load encryption key from Keychain (macOS) — must complete before any secret access
await initSecretStore();

// Resolve login shell env for hook execution (non-blocking — best effort)
resolveLoginShellEnv().catch(() => {});

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

const server = Bun.serve<WsData>({
  port: config.port,
  hostname: "127.0.0.1",

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws/yaml-lsp") {
      const upgraded = server.upgrade(req, { data: { type: "yaml-lsp" as const } });
      if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 });
      return undefined;
    }

    {
      const worktreeLspTypes: WorktreeLspType[] = [
        "ts-lsp",
        "docker-lsp",
        "terraform-lsp",
        "python-lsp",
        "astro-lsp",
        "xml-lsp",
      ];
      for (const lspType of worktreeLspTypes) {
        if (url.pathname !== `/ws/${lspType}`) continue;
        const wtPath = url.searchParams.get("wt");
        if (!wtPath) return new Response("Missing 'wt' query parameter", { status: 400 });
        const upgraded = server.upgrade(req, { data: { type: lspType, wtPath } });
        if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 });
        return undefined;
      }
    }

    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, { data: { type: "app" as const } });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    if (url.pathname.startsWith("/api")) {
      return handleRequest(req, {
        broadcastToSubscribers,
        broadcastToProject,
        broadcastAll,
        sendToActiveWindow,
        externalFolderConflict: externalFolderConflictFor,
        getProject: (cwd: string) => projects.get(cwd),
        findProjectForPath,
        getWorktreeResources: (wtPath: string) => wtResources.get(wtPath),
        suspendWorktreeWatchers,
        completeWorktreeRemoval,
        resolveFilePath,
        initializeProject,
        teardownProject,
        shutdown,
        resolveSchema: (url, baseDir) => schemaService.resolve(url, baseDir),
        updateYamlSchemas: (schemaMap) => yamlLspManager.updateSchemas(schemaMap),
        formatContent: (content, filePath, wtPath, settings) =>
          formatService.format(content, filePath, wtPath, settings),
        getDetectedFormatters: (wtPath) => formatService.getDetectedFormatters(wtPath),
      });
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

    return handleRequest(req, {
      broadcastToSubscribers,
      broadcastToProject,
      broadcastAll,
      sendToActiveWindow,
      externalFolderConflict: externalFolderConflictFor,
      getProject: (cwd: string) => projects.get(cwd),
      findProjectForPath,
      getWorktreeResources: (wtPath: string) => wtResources.get(wtPath),
      suspendWorktreeWatchers,
      completeWorktreeRemoval,
      resolveFilePath,
      initializeProject,
      teardownProject,
      shutdown,
      resolveSchema: (url, baseDir) => schemaService.resolve(url, baseDir),
      updateYamlSchemas: (schemaMap) => yamlLspManager.updateSchemas(schemaMap),
      formatContent: (content, filePath, wtPath, settings) =>
        formatService.format(content, filePath, wtPath, settings),
      getDetectedFormatters: (wtPath) => formatService.getDetectedFormatters(wtPath),
    });
  },

  websocket: {
    open(ws) {
      if (ws.data?.type === "yaml-lsp") {
        yamlLspManager.attach(ws);
        return;
      }
      if (ws.data?.type === "ts-lsp") {
        tsLspManager.createSession(ws, ws.data.wtPath);
        return;
      }
      if (ws.data?.type === "docker-lsp") {
        dockerLspManager.createSession(ws, ws.data.wtPath);
        return;
      }
      if (ws.data?.type === "terraform-lsp") {
        terraformLspManager.createSession(ws, ws.data.wtPath);
        return;
      }
      if (ws.data?.type === "python-lsp") {
        pythonLspManager.createSession(ws, ws.data.wtPath);
        return;
      }
      if (ws.data?.type === "astro-lsp") {
        astroLspManager.createSession(ws, ws.data.wtPath);
        return;
      }
      if (ws.data?.type === "xml-lsp") {
        xmlLspManager.createSession(ws, ws.data.wtPath);
        return;
      }
      if (shuttingDown) {
        ws.close(1001, "Server shutting down");
        return;
      }
      if (idleShutdownTimer) {
        clearTimeout(idleShutdownTimer);
        idleShutdownTimer = null;
        log.info("Idle shutdown cancelled — client connected");
      }
      clients.set(ws, { terminals: new Set(), subscribedWorktrees: new Set() });
      sendTo(ws, { type: "notifications_sync", data: notificationStore.getAll() });
      log.debug(`Client connected (${clients.size} total)`);
    },

    close(ws) {
      if (ws.data?.type === "yaml-lsp") {
        yamlLspManager.detach(ws);
        return;
      }
      if (ws.data?.type === "ts-lsp") {
        tsLspManager.destroySession(ws);
        return;
      }
      if (ws.data?.type === "docker-lsp") {
        dockerLspManager.destroySession(ws);
        return;
      }
      if (ws.data?.type === "terraform-lsp") {
        terraformLspManager.destroySession(ws);
        return;
      }
      if (ws.data?.type === "python-lsp") {
        pythonLspManager.destroySession(ws);
        return;
      }
      if (ws.data?.type === "astro-lsp") {
        astroLspManager.destroySession(ws);
        return;
      }
      if (ws.data?.type === "xml-lsp") {
        xmlLspManager.destroySession(ws);
        return;
      }
      unsubscribeAllWorktrees(ws);
      detachClientTerminals(ws);
      detachClientAgents(ws);
      logSubscribers.delete(ws);
      clients.delete(ws);
      if (lastFocusedClient === ws) lastFocusedClient = null;
      log.debug(`Client disconnected (${clients.size} remaining)`);

      if (clients.size === 0 && !idleShutdownTimer && !shuttingDown) {
        const hasOrphans = ptyManager.hasOrphanSessions() || agentManager.hasOrphanSessions();
        if (hasOrphans) {
          // Orphaned sessions exist — give clients time to reconnect (e.g. after hibernation wake)
          // before destroying them and shutting down
          log.info(
            `No clients remaining, orphaned sessions waiting for reattach ` +
              `(${ORPHAN_CLEANUP_MS / 1000}s timeout)`,
          );
          idleShutdownTimer = setTimeout(() => {
            const destroyed = ptyManager.destroyOrphans();
            if (destroyed > 0) log.info(`Destroyed ${destroyed} orphaned terminal(s)`);
            log.info("Idle timeout reached, shutting down");
            shutdown();
          }, ORPHAN_CLEANUP_MS);
        } else {
          log.info(`No clients remaining, shutting down in ${IDLE_SHUTDOWN_MS / 1000}s`);
          idleShutdownTimer = setTimeout(() => {
            log.info("Idle timeout reached, shutting down");
            shutdown();
          }, IDLE_SHUTDOWN_MS);
        }
      }
    },

    message(ws, message) {
      if (ws.data?.type === "yaml-lsp") {
        if (typeof message === "string") yamlLspManager.handleMessage(ws, message);
        return;
      }
      if (ws.data?.type === "ts-lsp") {
        if (typeof message === "string") tsLspManager.handleMessage(ws, message);
        return;
      }
      if (ws.data?.type === "docker-lsp") {
        if (typeof message === "string") dockerLspManager.handleMessage(ws, message);
        return;
      }
      if (ws.data?.type === "terraform-lsp") {
        if (typeof message === "string") terraformLspManager.handleMessage(ws, message);
        return;
      }
      if (ws.data?.type === "python-lsp") {
        if (typeof message === "string") pythonLspManager.handleMessage(ws, message);
        return;
      }
      if (ws.data?.type === "astro-lsp") {
        if (typeof message === "string") astroLspManager.handleMessage(ws, message);
        return;
      }
      if (ws.data?.type === "xml-lsp") {
        if (typeof message === "string") xmlLspManager.handleMessage(ws, message);
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

log.info(`Server listening on http://${server.hostname}:${server.port}`);
log.info(`State directory: ${config.stateDir}${config.isDev ? " (dev)" : ""}`);
if (projects.size === 0) log.info("No projects registered, waiting for project selection");

const perfMonitor = createServerPerfMonitor();

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
  log.info("Server shutting down");

  // Teardown all worktree resources
  for (const [wtPath, resources] of wtResources) {
    teardownWorktreeResources(wtPath, resources);
  }

  // Teardown all project resources (also cancels their pending worktree status sweeps)
  for (const cwd of Array.from(projects.keys())) {
    teardownProject(cwd);
  }

  ptyManager.destroyAll();
  agentManager.destroyAll().catch(() => {});
  formatService.destroy();
  yamlLspManager.destroy();
  tsLspManager.destroy();
  dockerLspManager.destroy();
  terraformLspManager.destroy();
  pythonLspManager.destroy();
  astroLspManager.destroy();
  xmlLspManager.destroy();
  perfMonitor.dispose();
  stress.dispose();
  logger.shutdown();
  server.stop();
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

process.on("uncaughtException", (err) => {
  log.error("Uncaught exception, shutting down", { error: err });
  shutdown(1);
});

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection", {
    error: reason instanceof Error ? reason : undefined,
    message: reason instanceof Error ? undefined : String(reason),
  });
});

// --- Background update check (production only) ---

if (!config.isDev) {
  const { cleanupStaleUpdates, checkForUpdate } = await import("./update");
  cleanupStaleUpdates();
  setTimeout(() => checkForUpdate(broadcastAll), 5_000);
}
