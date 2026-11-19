import type { FormattingSettings } from "@/lib/formatting-model";
import type { SchemaFileMatch } from "@/lib/schema-glob";
import type { OpenRequest, OpenResult } from "@/open-request";

import type { AgentTerminalAnswer } from "./agent-terminal-model";
import type { TypeScriptDiagnostic } from "./diagnostics-model";
import type { DiffInfo } from "./diff-model";
import type { EditorConfigResponse } from "./editorconfig-model";
import type {
  BranchCommits,
  BranchInfo,
  CommitInfo,
  GraphData,
  RefInfo,
  StatusInfo,
  WorktreeStatusInfo,
} from "./git-models";
import { localConnection, localRef, localServerId, setLocalServerId } from "./local-server";
import type { LogEntry } from "./log-entry-model";
import type { OpenInApps, OpenWithAppRequest, RevealInFinderRequest } from "./open-in-model";
import type { DirEntry } from "./project-files-model";
import type {
  AddProjectRequest,
  BrowseEntry,
  CloneProjectRequest,
  ConvertProjectRequest,
  CreateProjectRequest,
  DetectPathResult,
  InitProjectRequest,
  Project,
  ProjectSetupResult,
  ProjectsResponse,
  ProjectWorktreesResponse,
  ScanSuggestionsResult,
  WorktreeBasePlan,
} from "./project-model";
import type {
  Comment,
  CommentThread,
  CreateReviewRequest,
  CreateThreadRequest,
  DiffFileContext,
  PlacedThread,
  Review,
} from "./review-model";
import type { RunningTerminal } from "./running-terminals-model";
import { RunningTerminalsSchema } from "./running-terminals-model";
import type { SchemaConsentDecision } from "./schema-consent-model";
import {
  connectionOf,
  fetchApiJson,
  hasConnection,
  LOCAL_BASE_URL,
  registerConnection,
  scopedConnection,
  ServerConnection,
} from "./server-connection";
import { BIN_MSG_OUTPUT, encodeInputFrame, parseOutputFrame } from "./terminal-stream";
import {
  type ServerId,
  type WorktreeRef,
  type WorktreeRefKey,
  formatWorktreeRef,
} from "./worktree-ref";
import type {
  NestedRemoval,
  WorktreeRemovePlan,
  WorktreeRemoveResult,
} from "./worktree-removal-model";
import type { ServerIdentity, WsClientMessage, WsMessage } from "./ws-protocol";
import { type ConnectionState, reconnectDelay, sentAfterReconnect } from "./ws-reconnect";

/** Append wt or project scope param to a URL path. */
export function withScope(path: string, scope: { wt?: string; project?: string }): string {
  const url = new URL(`http://x${path}`);
  if (scope.wt) url.searchParams.set("wt", scope.wt);
  if (scope.project) url.searchParams.set("project", scope.project);
  return `${url.pathname}${url.search}`;
}

/** The connection of the worktree `wt`'s server, for a request about that worktree. */
function on(wt: WorktreeRef): ServerConnection {
  return connectionOf(wt.server);
}

/**
 * A request to the window's own server, at the origin the window was loaded from, for the
 * window's own state: its stores and its log. These start as modules load, before the server's id
 * is known and its connection made, so they need no connection; a refused session still expires
 * the window's socket, as on the connection.
 */
function windowFetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  return fetchApiJson<T>(LOCAL_BASE_URL, path, options, () => wsClient.expireSession());
}

// Store persistence (server-backed Zustand storage): the window's state, on its own server.
export async function getStore(key: string): Promise<string | null> {
  const { value } = await windowFetchJson<{ value: string | null }>(
    `/stores/${encodeURIComponent(key)}`,
  );
  return value;
}

export async function putStore(
  key: string,
  value: string,
  nonce?: string,
  options?: Pick<RequestInit, "keepalive">,
): Promise<void> {
  await windowFetchJson(`/stores/${encodeURIComponent(key)}`, {
    ...options,
    method: "PUT",
    body: JSON.stringify({ value, nonce }),
  });
}

// GET endpoints
type LogQueryOptions = { limit?: number; all?: boolean; branches?: string[]; since?: string };

function buildLogParams(options?: LogQueryOptions): string {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.all) params.set("all", "true");
  if (options?.branches?.length) params.set("branches", options.branches.join(","));
  if (options?.since) params.set("since", options.since);
  const query = params.toString();
  return query ? `?${query}` : "";
}

// Server logs — ingest a frontend log entry via the server pipeline
export function postLogEntry(entry: {
  level: string;
  cat: string;
  msg: string;
  ctx?: Record<string, unknown>;
}): void {
  // Fire-and-forget — logging should never block the UI. The window's log goes to its own server,
  // from the start, before its connection exists (`windowFetchJson`).
  fetch(`${LOCAL_BASE_URL}/api/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  }).catch(() => {});
}

// Server logs
export async function getLogs(options?: {
  before?: number;
  limit?: number;
}): Promise<{ entries: LogEntry[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (options?.before !== undefined) params.set("before", String(options.before));
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();
  // The Logs panel shows the window's own server's log.
  return windowFetchJson(`/logs${query ? `?${query}` : ""}`);
}

export async function getLog(wt: WorktreeRef, options?: LogQueryOptions) {
  return on(wt).fetchJson<CommitInfo[]>(
    withScope(`/log${buildLogParams(options)}`, { wt: wt.path }),
  );
}

export async function getGraph(wt: WorktreeRef, options?: LogQueryOptions) {
  return on(wt).fetchJson<GraphData>(
    withScope(`/graph${buildLogParams(options)}`, { wt: wt.path }),
  );
}

export async function getBranchCommits(wt: WorktreeRef, options?: { limit?: number }) {
  const limitParam = options?.limit ? `?limit=${options.limit}` : "";
  return on(wt).fetchJson<BranchCommits>(
    withScope(`/branch-commits${limitParam}`, { wt: wt.path }),
  );
}

export async function getStatus(wt: WorktreeRef) {
  return on(wt).fetchJson<StatusInfo>(withScope("/status", { wt: wt.path }));
}

export async function getDiff(
  wt: WorktreeRef,
  options?: { staged?: boolean; commit?: string; range?: string; worktree?: string; base?: string },
) {
  const params = new URLSearchParams();
  params.set("wt", wt.path);
  if (options?.staged) params.set("staged", "true");
  if (options?.commit) params.set("commit", options.commit);
  if (options?.range) params.set("range", options.range);
  if (options?.worktree) params.set("worktree", options.worktree);
  if (options?.base) params.set("base", options.base);

  const query = params.toString();
  return on(wt).fetchJson<DiffInfo>(`/diff${query ? `?${query}` : ""}`);
}

export async function getBranches(wt: WorktreeRef) {
  return on(wt).fetchJson<BranchInfo[]>(withScope("/branches", { wt: wt.path }));
}

export async function getRecentBranchNames(wt: WorktreeRef, days: number) {
  return on(wt).fetchJson<string[]>(withScope(`/branches/recent?days=${days}`, { wt: wt.path }));
}

export async function getRefs(wt: WorktreeRef) {
  return on(wt).fetchJson<RefInfo[]>(withScope("/refs", { wt: wt.path }));
}

export async function getFileLines(
  wt: WorktreeRef,
  options: { path: string; startLine: number; endLine: number; ref?: string },
) {
  const params = new URLSearchParams();
  params.set("wt", wt.path);
  params.set("path", options.path);
  params.set("startLine", String(options.startLine));
  params.set("endLine", String(options.endLine));
  if (options.ref) params.set("ref", options.ref);

  return on(wt).fetchJson<{ lines: string[] }>(`/file-lines?${params.toString()}`);
}

/** Read a file of `server` from git (at `ref`) or from a worktree on disk (`worktree`), as lines. */
export async function getFileContent(
  server: ServerId,
  options: { path: string; ref?: string; worktree?: string; wt?: string },
) {
  const params = new URLSearchParams();
  params.set("path", options.path);
  if (options.ref) params.set("ref", options.ref);
  if (options.worktree) params.set("worktree", options.worktree);
  if (options.wt) params.set("wt", options.wt);

  return connectionOf(server).fetchJson<{ lines: string[] }>(`/file-content?${params.toString()}`);
}

/** Read file content by absolute path. Used by editors (returns content as string, not lines). */
export async function getFileContentByPath(
  server: ServerId,
  absolutePath: string,
  wt?: WorktreeRef | null,
  signal?: AbortSignal,
): Promise<{ content: string }> {
  const connection = scopedConnection(server, wt);
  const params = new URLSearchParams();
  params.set("path", absolutePath);
  if (wt) {
    params.set("wt", wt.path);
    await connection.ws.whenSubscribed(wt);
  }
  return connection.fetchJson<{ content: string }>(`/file-content?${params.toString()}`, {
    signal,
  });
}

/**
 * A file's content for a look only, such as a peek widget's: unlike `getFileContentByPath` it
 * neither tracks the file for renames nor adds a file outside every tree to the worktree's Others.
 */
export async function getFilePreviewContent(
  server: ServerId,
  absolutePath: string,
  wt?: WorktreeRef | null,
): Promise<{ content: string }> {
  const connection = scopedConnection(server, wt);
  const params = new URLSearchParams();
  params.set("path", absolutePath);
  if (wt) {
    params.set("wt", wt.path);
    await connection.ws.whenSubscribed(wt);
  }
  params.set("preview", "1");
  return connection.fetchJson<{ content: string }>(`/file-content?${params.toString()}`);
}

/** The `.editorconfig` properties that apply to a file (empty when none do). */
export async function getEditorConfig(
  server: ServerId,
  absolutePath: string,
  wt?: WorktreeRef | null,
  signal?: AbortSignal,
): Promise<EditorConfigResponse> {
  const connection = scopedConnection(server, wt);
  const params = new URLSearchParams();
  params.set("path", absolutePath);
  if (wt) params.set("wt", wt.path);
  return connection.fetchJson<EditorConfigResponse>(`/editorconfig?${params.toString()}`, {
    signal,
  });
}

export async function writeFileContent(
  server: ServerId,
  {
    worktree,
    ...options
  }: {
    path: string;
    content: string;
    nonce: string;
    /** The worktree the file is written as part of, on `server`. */
    worktree?: WorktreeRef;
    format?: boolean;
    formattingSettings?: FormattingSettings;
    /**
     * Write only if the file still holds this (what a retried save was merged onto); otherwise the
     * server refuses with {@link isDiskChangedError}.
     */
    expectedContent?: string;
  },
) {
  // `formatNotice`: why a save requested with `format` went out unformatted, when the user can
  // act on it (formatter not installed, timed out).
  return scopedConnection(server, worktree).fetchJson<{
    success: boolean;
    content?: string;
    formatNotice?: string;
  }>("/file-write", {
    method: "POST",
    body: JSON.stringify({ ...options, worktreePath: worktree?.path }),
  });
}

export interface DetectedFormatter {
  command: string;
  extensions: string[];
}

// "Open In" (macOS): Finder reveal and open-with-app for files Loxel manages. They act on the apps
// of the machine the window runs on, so they go to the window's own server.

export async function getOpenInApps(path: string): Promise<OpenInApps> {
  return localConnection().fetchJson<OpenInApps>(`/open-in/apps?path=${encodeURIComponent(path)}`);
}

/** URL of an app's icon PNG, for use as an `<img>` source. */
export function getOpenInAppIconUrl(appPath: string): string {
  return localConnection().apiUrl(`/open-in/app-icon?app=${encodeURIComponent(appPath)}`);
}

export async function revealInFinder(request: RevealInFinderRequest): Promise<void> {
  await localConnection().fetchJson("/open-in/reveal", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function openWithApp(request: OpenWithAppRequest): Promise<void> {
  await localConnection().fetchJson("/open-in/open", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function getDetectedFormatters(wt: WorktreeRef): Promise<DetectedFormatter[]> {
  const params = new URLSearchParams({ wt: wt.path });
  const result = await on(wt).fetchJson<{ formatters: DetectedFormatter[] }>(
    `/detected-formatters?${params.toString()}`,
  );
  return result.formatters;
}

// --- Full-text search ---

export async function search(
  wt: WorktreeRef,
  options: {
    q: string;
    regex?: boolean;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    maxResults?: number;
    scope?: "all" | "worktree" | "drafts" | "ignored";
    paths?: string[];
    globs?: string[];
  },
  signal?: AbortSignal,
) {
  const params = new URLSearchParams();
  params.set("wt", wt.path);
  params.set("q", options.q);
  if (options.regex) params.set("regex", "true");
  if (options.caseSensitive) params.set("caseSensitive", "true");
  if (options.wholeWord) params.set("wholeWord", "true");
  if (options.maxResults) params.set("maxResults", String(options.maxResults));
  if (options.scope && options.scope !== "all") params.set("scope", options.scope);
  if (options.paths?.length) params.set("paths", options.paths.join(","));
  if (options.globs?.length) params.set("globs", options.globs.join(","));
  return on(wt).fetchJson<import("./search-model").SearchResponse>(`/search?${params.toString()}`, {
    signal,
  });
}

export async function getSearchScopes(wt: WorktreeRef) {
  return on(wt).fetchJson<{
    packages: Array<import("@/components/search/search-scope-model").WorkspacePackage>;
    dirs: string[];
    extensions: string[];
  }>(withScope("/search-scopes", { wt: wt.path }));
}

export async function getFileIndex(wt: WorktreeRef) {
  return on(wt).fetchJson<import("@/store/file-search").FileIndexEntry>(
    withScope("/file-index", { wt: wt.path }),
  );
}

// --- Detached files (drafts) ---

export async function getDetachedFiles(wt: WorktreeRef) {
  return on(wt).fetchJson<DirEntry[]>(withScope("/detached-files", { wt: wt.path }));
}

/** The worktree's Others section: open folders (`isDir`), then individually opened files. */
export async function getExternalFiles(wt: WorktreeRef) {
  return on(wt).fetchJson<DirEntry[]>(withScope("/external-files", { wt: wt.path }));
}

/**
 * Send an open request (`POST /api/open`), the one the `loxel` CLI sends: for the quickstart's
 * command field, a terminal the server starts with its command typed in.
 */
export async function postOpenRequest(server: ServerId, request: OpenRequest) {
  return connectionOf(server).fetchJson<OpenResult>("/open", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

/** Open a folder in the worktree's Others section. Returns the root it is shown under. */
export async function addExternalFolder(wt: WorktreeRef, path: string) {
  return on(wt).fetchJson<{ root: string }>("/external-folders/add", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path, path }),
  });
}

export async function removeExternalFolder(wt: WorktreeRef, path: string) {
  return on(wt).fetchJson<{ removed: boolean }>("/external-folders/remove", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path, path }),
  });
}

/**
 * Resolve a path (`~/` expanded) and report whether it is a directory, its size and modification
 * time. Throws when missing.
 */
export async function getPathInfo(server: ServerId, path: string) {
  return connectionOf(server).fetchJson<{
    path: string;
    isDir: boolean;
    size: number;
    mtimeMs: number;
  }>(`/path-info?${new URLSearchParams({ path }).toString()}`);
}

export async function createDetachedFile(
  wt: WorktreeRef,
  options: { prefix: string; ext?: string; content?: string },
) {
  return on(wt).fetchJson<{ name: string; path: string }>("/detached-file-create", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path, ...options }),
  });
}

export async function moveDetachedFileToProject(
  wt: WorktreeRef,
  options: { path: string; destPath: string },
) {
  return on(wt).fetchJson<{ newPath: string }>("/detached-file-move", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path, ...options }),
  });
}

export async function deleteDetachedFile(wt: WorktreeRef, path: string) {
  return on(wt).fetchJson<{ success: boolean }>("/detached-file-delete", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path, path }),
  });
}

export async function renameDetachedFile(wt: WorktreeRef, path: string, newName: string) {
  return on(wt).fetchJson<{ success: boolean }>("/detached-file-rename", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path, path, newName }),
  });
}

export async function copyDetachedFileToProject(
  wt: WorktreeRef,
  options: { path: string; destPath: string },
) {
  return on(wt).fetchJson<{ newPath: string }>("/detached-file-copy-to-project", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path, ...options }),
  });
}

export async function getWorktreeStatuses(wt: WorktreeRef) {
  return on(wt).fetchJson<WorktreeStatusInfo[]>(withScope("/worktree-statuses", { wt: wt.path }));
}

export async function getDiagnostics(wt: WorktreeRef, ref?: string, worktree?: string) {
  const params = new URLSearchParams();
  params.set("wt", wt.path);
  if (ref) params.set("ref", ref);
  if (worktree) params.set("worktree", worktree);
  const query = params.toString();
  return on(wt).fetchJson<{ diagnostics: TypeScriptDiagnostic[]; error?: string }>(
    `/diagnostics${query ? `?${query}` : ""}`,
  );
}

// POST endpoints — all accept worktreePath to identify scope
export async function stageFiles(wt: WorktreeRef, files: string[]) {
  return on(wt).fetchJson<{ success: boolean }>("/stage", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, files }),
  });
}

export async function unstageFiles(wt: WorktreeRef, files: string[]) {
  return on(wt).fetchJson<{ success: boolean }>("/unstage", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, files }),
  });
}

export async function createCommit(wt: WorktreeRef, message: string) {
  return on(wt).fetchJson<{ commit: string }>("/commit", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, message }),
  });
}

export async function checkout(wt: WorktreeRef, ref: string) {
  return on(wt).fetchJson<{ success: boolean }>("/checkout", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, ref }),
  });
}

export async function reset(wt: WorktreeRef, commit: string, mode: "soft" | "mixed" | "hard") {
  return on(wt).fetchJson<{ success: boolean }>("/reset", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, commit, mode }),
  });
}

export async function cherryPick(wt: WorktreeRef, commits: string[]) {
  return on(wt).fetchJson<{ success: boolean }>("/cherry-pick", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, commits }),
  });
}

export async function revert(wt: WorktreeRef, commits: string[]) {
  return on(wt).fetchJson<{ success: boolean }>("/revert", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, commits }),
  });
}

export async function createBranch(wt: WorktreeRef, name: string, startPoint?: string) {
  return on(wt).fetchJson<{ success: boolean }>("/branch/create", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, name, startPoint }),
  });
}

export async function deleteBranch(wt: WorktreeRef, name: string, force?: boolean) {
  return on(wt).fetchJson<{ success: boolean }>("/branch/delete", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, name, force }),
  });
}

export async function renameBranch(wt: WorktreeRef, oldName: string, newName: string) {
  return on(wt).fetchJson<{ success: boolean }>("/branch/rename", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, oldName, newName }),
  });
}

export async function discardChanges(wt: WorktreeRef, files: string[]) {
  return on(wt).fetchJson<{ success: boolean }>("/discard", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, files }),
  });
}

/** Discard every local change to `files` — staged, unstaged and untracked — making them match HEAD. */
export async function revertToHead(wt: WorktreeRef, files: string[]) {
  return on(wt).fetchJson<{ success: boolean }>("/revert-to-head", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, files }),
  });
}

export async function stageHunk(wt: WorktreeRef, patch: string) {
  return on(wt).fetchJson<{ success: boolean }>("/stage-hunk", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, patch }),
  });
}

export async function unstageHunk(wt: WorktreeRef, patch: string) {
  return on(wt).fetchJson<{ success: boolean }>("/unstage-hunk", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, patch }),
  });
}

// --- Project API ---

export async function getProjects(server: ServerId) {
  return connectionOf(server).fetchJson<ProjectsResponse>("/projects");
}

export async function addProject(server: ServerId, req: AddProjectRequest) {
  return connectionOf(server).fetchJson<ProjectSetupResult>("/projects", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/** `id` is the project's id on `server`. */
export async function removeProject(server: ServerId, id: string) {
  return connectionOf(server).fetchJson<{ success: boolean }>(`/projects/${id}`, {
    method: "DELETE",
  });
}

export async function deleteProject(server: ServerId, id: string) {
  return connectionOf(server).fetchJson<{ success: boolean }>(`/projects/${id}/delete`, {
    method: "POST",
  });
}

export async function updateProject(server: ServerId, id: string, updates: { name?: string }) {
  return connectionOf(server).fetchJson<Project>(`/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function browse(server: ServerId, path?: string) {
  const params = path ? `?path=${encodeURIComponent(path)}` : "";
  return connectionOf(server).fetchJson<{ path: string; dirs: BrowseEntry[] }>(`/browse${params}`);
}

export type { BrowseEntry };

// --- Add Project Wizard API ---

export async function detectPath(server: ServerId, path: string) {
  return connectionOf(server).fetchJson<DetectPathResult>("/projects/detect", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export async function scanSuggestions(server: ServerId, path: string) {
  return connectionOf(server).fetchJson<ScanSuggestionsResult>(
    `/projects/scan-suggestions?path=${encodeURIComponent(path)}`,
  );
}

export async function createProject(server: ServerId, req: CreateProjectRequest) {
  return connectionOf(server).fetchJson<ProjectSetupResult>("/projects/create", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function cloneProject(server: ServerId, req: CloneProjectRequest) {
  return connectionOf(server).fetchJson<ProjectSetupResult>("/projects/clone", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function initProject(server: ServerId, req: InitProjectRequest) {
  return connectionOf(server).fetchJson<ProjectSetupResult>("/projects/init", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function convertProject(server: ServerId, req: ConvertProjectRequest) {
  return connectionOf(server).fetchJson<ProjectSetupResult>("/projects/convert", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

// --- Schema API ---

export async function syncSchemas(
  server: ServerId,
  schemas: Array<SchemaFileMatch & { url: string }>,
): Promise<void> {
  await connectionOf(server).fetchJson("/schemas/sync", {
    method: "POST",
    body: JSON.stringify({ schemas }),
  });
}

export async function ensureSchemas(server: ServerId, urls: readonly string[]): Promise<void> {
  await connectionOf(server).fetchJson("/schemas/ensure", {
    method: "POST",
    body: JSON.stringify({ urls }),
  });
}

/** Record a decision on a schema URL a project file names; null forgets it. */
export async function decideSchemaConsent(
  server: ServerId,
  url: string,
  decision: SchemaConsentDecision | null,
): Promise<void> {
  await connectionOf(server).fetchJson("/schemas/consent", {
    method: "POST",
    body: JSON.stringify({ url, decision }),
  });
}

export async function setSchemaNeverFetch(server: ServerId, neverFetch: boolean): Promise<void> {
  await connectionOf(server).fetchJson("/schemas/never-fetch", {
    method: "POST",
    body: JSON.stringify({ neverFetch }),
  });
}

/** `baseDir` is a directory on `server`, which relative schema paths resolve against. */
export async function resolveSchema(
  server: ServerId,
  url: string,
  baseDir?: string,
): Promise<unknown> {
  const params = new URLSearchParams({ url });
  if (baseDir) params.set("baseDir", baseDir);
  try {
    return await connectionOf(server).fetchJson<unknown>(`/schemas/resolve?${params.toString()}`);
  } catch {
    return null;
  }
}

// --- Agents' terminals API ---

/** Answer an agent's terminal request; `windowId` (this window) gets the terminal. */
export async function answerAgentTerminal(
  server: ServerId,
  id: string,
  answer: AgentTerminalAnswer,
  windowId: string,
): Promise<void> {
  await connectionOf(server).fetchJson("/agent-terminals/answer", {
    method: "POST",
    body: JSON.stringify({ id, answer, windowId }),
  });
}

/** Ask again in every worktree where the user chose "Always in this worktree". */
export async function clearAgentTerminalWorktrees(server: ServerId): Promise<void> {
  await connectionOf(server).fetchJson("/agent-terminals/clear-always", { method: "POST" });
}

// --- Worktree API ---

export type { AddPlan as AddWorktreePlan, AddResult as AddWorktreeResult } from "@bizimind/wt/lib";
export type {
  InitAction as WorktreeMetadataAction,
  RemoveResult as RemoveWorktreeResult,
} from "@bizimind/wt/lib";

/** `projectId` is the project's id on `server`. */
export async function getProjectWorktrees(server: ServerId, projectId: string) {
  return connectionOf(server).fetchJson<ProjectWorktreesResponse>(
    `/projects/${encodeURIComponent(projectId)}/worktrees`,
  );
}

export async function planAddWorktree(project: WorktreeRef, name: string) {
  return on(project).fetchJson<import("@bizimind/wt/lib").AddPlan>("/worktree/plan-add", {
    method: "POST",
    body: JSON.stringify({ projectPath: project.path, name }),
  });
}

/** Where a new worktree would start; with `parentPath`, also that worktree's commit. */
export async function planWorktreeBase(project: WorktreeRef, parentPath?: string) {
  return on(project).fetchJson<WorktreeBasePlan>("/worktree/plan-base", {
    method: "POST",
    body: JSON.stringify({ projectPath: project.path, parentPath }),
  });
}

export interface CreateWorktreeOptions {
  branch?: string;
  branchResolution?: "use-existing" | "delete-and-create";
  /** Create a child of this worktree: nested under it, branched from the remote default */
  parentPath?: string;
  /** Branch a child from its parent's current commit instead of the remote default */
  fromParent?: boolean;
  /** Show the new worktree by this title (`loxel-title` metadata) */
  title?: string;
}

export async function createWorktree(
  project: WorktreeRef,
  name: string,
  options?: CreateWorktreeOptions,
) {
  return on(project).fetchJson<import("@bizimind/wt/lib").AddResult>("/worktree/create", {
    method: "POST",
    body: JSON.stringify({ projectPath: project.path, name, ...options }),
  });
}

/** Run the `init.wt.sh` a worktree's creation held back, once its repository is trusted. */
export async function runInitHook(project: WorktreeRef, wtPath: string) {
  return on(project).fetchJson<{ hookRan: boolean }>("/worktree/run-init-hook", {
    method: "POST",
    body: JSON.stringify({ projectPath: project.path, path: wtPath }),
  });
}

/** Nest a worktree under another or move it to the top level (`parentPath: null`), or rename it. */
export async function updateWorktreeMeta(
  project: WorktreeRef,
  wtPath: string,
  update: { parentPath?: string | null; title?: string | null },
) {
  return on(project).fetchJson<{ success: true }>("/worktree/meta", {
    method: "POST",
    body: JSON.stringify({ projectPath: project.path, path: wtPath, ...update }),
  });
}

/** The `wt init` action that turns on worktree metadata; null when there is nothing to do. */
export async function planEnableWorktreeMetadata(project: WorktreeRef) {
  return on(project).fetchJson<{ action: import("@bizimind/wt/lib").InitAction | null }>(
    "/worktree/plan-enable-metadata",
    { method: "POST", body: JSON.stringify({ projectPath: project.path }) },
  );
}

export async function enableWorktreeMetadata(project: WorktreeRef) {
  return on(project).fetchJson<{ status: "applied" | "not-needed" }>("/worktree/enable-metadata", {
    method: "POST",
    body: JSON.stringify({ projectPath: project.path }),
  });
}

export async function planRemoveWorktree(project: WorktreeRef, wtPath: string) {
  return on(project).fetchJson<WorktreeRemovePlan>("/worktree/plan-remove", {
    method: "POST",
    body: JSON.stringify({ projectPath: project.path, path: wtPath }),
  });
}

export async function removeWorktreeByWtPath(
  project: WorktreeRef,
  wtPath: string,
  options: {
    deleteBranch: boolean;
    force: boolean;
    nested?: NestedRemoval;
    /** With `nested: "remove"`: the nested worktrees the user confirmed removing */
    nestedPaths?: string[];
  },
) {
  return on(project).fetchJson<WorktreeRemoveResult>("/worktree/remove", {
    method: "POST",
    body: JSON.stringify({ projectPath: project.path, path: wtPath, ...options }),
  });
}

// --- Project file operations ---

import type { FileOperationResult } from "./file-operations-model";

export async function createProjectFile(wt: WorktreeRef, options: { dir: string; name?: string }) {
  return on(wt).fetchJson<{ path: string }>("/files/create-file", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path, ...options }),
  });
}

export async function createProjectDir(wt: WorktreeRef, options: { dir: string; name?: string }) {
  return on(wt).fetchJson<{ path: string }>("/files/create-dir", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path, ...options }),
  });
}

export async function copyProjectFile(
  wt: WorktreeRef,
  options: { srcPath: string; destDir: string },
) {
  return on(wt).fetchJson<{ newPath: string }>("/files/copy", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path, ...options }),
  });
}

export async function renameProjectFile(
  wt: WorktreeRef,
  options: { path: string; newName: string },
) {
  return on(wt).fetchJson<{ newPath: string }>("/files/rename", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path, ...options }),
  });
}

export async function deleteProjectFile(wt: WorktreeRef, path: string) {
  return on(wt).fetchJson<{ success: boolean }>("/files/delete", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path, path }),
  });
}

export async function moveProjectFile(
  wt: WorktreeRef,
  options: { srcPath: string; destDir: string },
) {
  return on(wt).fetchJson<{ newPath: string }>("/files/move", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path, ...options }),
  });
}

export async function undoFileOperation(wt: WorktreeRef) {
  return on(wt).fetchJson<{ result: FileOperationResult | null }>("/files/undo", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path }),
  });
}

export async function redoFileOperation(wt: WorktreeRef) {
  return on(wt).fetchJson<{ result: FileOperationResult | null }>("/files/redo", {
    method: "POST",
    body: JSON.stringify({ wt: wt.path }),
  });
}

// --- Project files API ---

export async function getDirContents(wt: WorktreeRef, dir: string) {
  const params = new URLSearchParams();
  params.set("wt", wt.path);
  if (dir) params.set("dir", dir);
  await on(wt).ws.whenSubscribed(wt);
  return on(wt).fetchJson<DirEntry[]>(`/files?${params.toString()}`);
}

export function unwatchDir(wt: WorktreeRef, dir: string) {
  // Fire-and-forget — no need to await cleanup
  fetch(on(wt).apiUrl("/files/unwatch"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wt: wt.path, dir }),
  }).catch(() => {});
}

// --- Review API ---

export async function getReviews(wt: WorktreeRef) {
  return on(wt).fetchJson<Review[]>(withScope("/reviews", { wt: wt.path }));
}

export async function createReview(wt: WorktreeRef, data: CreateReviewRequest) {
  return on(wt).fetchJson<Review>(withScope("/reviews", { wt: wt.path }), {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateReview(wt: WorktreeRef, id: string, updates: { name?: string }) {
  return on(wt).fetchJson<Review>(withScope(`/reviews/${id}`, { wt: wt.path }), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteReview(wt: WorktreeRef, id: string) {
  return on(wt).fetchJson<{ success: boolean }>(withScope(`/reviews/${id}`, { wt: wt.path }), {
    method: "DELETE",
  });
}

// --- Placed threads (server-side placement) ---

export async function postPlacedThreads(
  wt: WorktreeRef,
  reviewIds: string[],
  files: DiffFileContext[],
) {
  return on(wt).fetchJson<PlacedThread[]>(withScope("/placed-threads", { wt: wt.path }), {
    method: "POST",
    body: JSON.stringify({ reviewIds, files }),
  });
}

// --- Thread mutations ---

export async function createCommentThread(wt: WorktreeRef, data: CreateThreadRequest) {
  return on(wt).fetchJson<CommentThread>(withScope("/comments/threads", { wt: wt.path }), {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function addCommentReply(wt: WorktreeRef, threadId: string, body: string) {
  return on(wt).fetchJson<Comment>(
    withScope(`/comments/threads/${threadId}/comments`, { wt: wt.path }),
    { method: "POST", body: JSON.stringify({ body }) },
  );
}

export async function updateCommentThread(
  wt: WorktreeRef,
  threadId: string,
  status: "open" | "resolved",
) {
  return on(wt).fetchJson<CommentThread>(
    withScope(`/comments/threads/${threadId}`, { wt: wt.path }),
    { method: "PATCH", body: JSON.stringify({ status }) },
  );
}

export async function deleteCommentThread(wt: WorktreeRef, threadId: string) {
  return on(wt).fetchJson<{ success: boolean }>(
    withScope(`/comments/threads/${threadId}`, { wt: wt.path }),
    { method: "DELETE" },
  );
}

// Terminal output handler: receives raw PTY bytes for a specific terminal, tagged with the
// stream offset of their first byte.
type TerminalOutputHandler = (offset: number, data: Uint8Array) => void;

type ServerHello = Extract<WsMessage, { type: "server_hello" }>;

/**
 * The app's WebSocket to the server, as a singleton that survives disconnects. It retries with
 * backoff, and on every connection waits for the server's hello before sending anything: a new
 * version or a different server reloads the page; otherwise it re-subscribes the worktrees, runs
 * the reconnect listeners, then sends what was queued meanwhile (see `sentAfterReconnect`).
 */
export class WsClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private state: ConnectionState = "connecting";
  /** The server the last hello came from. */
  private server: ServerHello | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeListenersAdded = false;
  private listeners = new Set<(msg: WsMessage) => void>();
  private reconnectListeners = new Set<() => void>();
  private stateListeners = new Set<() => void>();
  private terminalOutputHandlers = new Map<string, TerminalOutputHandler>();
  private pendingMessages: WsClientMessage[] = [];
  /**
   * The worktrees this window is subscribed to, by ref, in order: the server takes the last as
   * shown.
   */
  private worktrees = new Map<WorktreeRefKey, WorktreeRef>();
  /** Of those, the ones whose resources the server has confirmed (`worktree_files_resynced`). */
  private confirmedWorktrees = new Set<WorktreeRefKey>();
  /** Callers of {@link whenSubscribed} waiting on a worktree's confirmation. */
  private confirmationWaiters = new Map<WorktreeRefKey, (() => void)[]>();

  connect(): void {
    this.closed = false;
    this.addWakeListeners();
    this.doConnect();
  }

  private doConnect(): void {
    this.retryTimer = null;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.binaryType = "arraybuffer";
    /** Whether the server's hello came on this socket. */
    let greeted = false;
    // Only the latest socket counts: one a disconnect left closing (as React's StrictMode does
    // with its double effect) must not retry or deliver beside it.
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      // Nothing is sent until the server's hello (its first message) says which server this is.
      postLogEntry({ level: "info", cat: "server", msg: "WebSocket connected" });
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      if (typeof event.data === "string") {
        // JSON text frame — control/git messages
        try {
          const raw: unknown = JSON.parse(event.data);
          if (typeof raw !== "object" || raw === null || !("type" in raw)) return;
          const message = raw as WsMessage;
          if (message.type === "server_hello") {
            greeted = true;
            this.handleHello(message);
            return;
          }
          if (message.type === "worktree_files_resynced") {
            this.confirmWorktree(message.wtPath);
          }
          // A refused subscription will not be confirmed: that worktree's reads go out (and fail)
          // as they would without the wait. The others' subscriptions are still answered.
          if (message.type === "error" && message.wtPath !== undefined) {
            this.confirmWorktree(message.wtPath);
          }
          for (const listener of this.listeners) {
            listener(message);
          }
        } catch (err) {
          postLogEntry({
            level: "error",
            cat: "server",
            msg: "WebSocket parse error",
            ctx: { error: err instanceof Error ? { message: err.message } : undefined },
          });
        }
      } else {
        // Binary frame — terminal output
        const buf = new Uint8Array(event.data as ArrayBuffer);
        if (buf[0] !== BIN_MSG_OUTPUT) return;
        const frame = parseOutputFrame(buf);
        if (!frame) return;
        const handler = this.terminalOutputHandlers.get(frame.terminalId);
        if (typeof handler !== "function") return;
        handler(frame.offset, frame.payload);
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      postLogEntry({ level: "warn", cat: "server", msg: "WebSocket disconnected" });
      this.ws = null;
      if (this.closed) return;
      if (this.state === "connected") this.setState("reconnecting");
      if (greeted) {
        this.scheduleRetry();
        return;
      }
      // A refused upgrade does not say why: ask whether the server still accepts this window's
      // session, or is only not there.
      void sessionRefused().then((refused) => {
        // Unless something else has moved on meanwhile (disconnect, a new connect).
        if (this.closed || this.ws !== null || this.retryTimer !== null) return;
        if (refused) this.expireSession();
        else this.scheduleRetry();
      });
    };

    ws.onerror = (err) => {
      postLogEntry({
        level: "error",
        cat: "server",
        msg: "WebSocket error",
        ctx: err instanceof ErrorEvent && err.message ? { message: err.message } : undefined,
      });
    };
  }

  private scheduleRetry(): void {
    this.retryTimer = setTimeout(() => this.doConnect(), reconnectDelay(this.attempt++));
  }

  /**
   * The server answered `401`: it does not take this window's session secret, which happens only
   * once a server with another one has replaced the one the window loaded from. Retrying cannot
   * help; the window says so and offers a reload.
   */
  expireSession(): void {
    if (this.state === "expired") return;
    // Not to the server, which refuses the window's requests now and logs each refusal itself.
    console.warn("The Loxel server no longer accepts this window's session; reload to reconnect");
    this.closed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.releaseWaiters();
    this.setState("expired");
  }

  /**
   * Waking from sleep or getting the network back usually means the server is reachable again, so
   * the next attempt need not wait out the backoff.
   */
  private addWakeListeners(): void {
    if (this.wakeListenersAdded) return;
    this.wakeListenersAdded = true;
    window.addEventListener("online", () => this.retryNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.retryNow();
    });
  }

  /** Reconnect now instead of when the backoff says; a no-op unless a retry is waiting. */
  retryNow(): void {
    if (this.closed || this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.doConnect();
  }

  /**
   * The server's hello opens every connection. A different version (a new build started) or a
   * server other than the one the window started with (`localServerId`, which its cached data is
   * keyed by) reloads the page to pick up its renderer and state. Otherwise the window re-creates
   * its per-connection state on the server and catches up, the same way whether the server
   * restarted (its boot epoch changed, which is logged) or only the socket dropped.
   */
  private handleHello(hello: ServerHello): void {
    const previous = this.server;
    const sameServer = hello.serverId === localServerId();
    if (!sameServer || (previous && hello.version !== previous.version)) {
      postLogEntry({
        level: "info",
        cat: "server",
        msg: "Server changed, reloading",
        ctx: { oldVersion: previous?.version, newVersion: hello.version, sameServer },
      });
      window.location.reload();
      return;
    }
    this.server = hello;
    // A restarted server has no worktree resources: each subscription below waits for its answer.
    this.confirmedWorktrees.clear();
    this.attempt = 0;
    for (const { path } of this.worktrees.values()) {
      this.sendNow({ type: "subscribe_worktree", worktreePath: path });
    }
    const queued = this.pendingMessages;
    this.pendingMessages = [];
    this.setState("connected");

    if (!previous) {
      for (const msg of queued) this.sendNow(msg);
      return;
    }
    postLogEntry({
      level: "info",
      cat: "server",
      msg:
        hello.bootEpoch === previous.bootEpoch
          ? "Reconnected"
          : "Reconnected to a restarted server",
    });
    for (const listener of this.reconnectListeners) {
      try {
        listener();
      } catch (err) {
        postLogEntry({
          level: "error",
          cat: "server",
          msg: "Reconnect listener failed",
          ctx: { error: err instanceof Error ? { message: err.message } : undefined },
        });
      }
    }
    for (const msg of queued) {
      if (sentAfterReconnect(msg)) this.sendNow(msg);
    }
  }

  private setState(state: ConnectionState): void {
    if (state === this.state) return;
    this.state = state;
    for (const listener of this.stateListeners) {
      try {
        listener();
      } catch (err) {
        postLogEntry({
          level: "error",
          cat: "server",
          msg: "Connection state listener failed",
          ctx: { error: err instanceof Error ? { message: err.message } : undefined },
        });
      }
    }
  }

  /** The connection state, for `useSyncExternalStore` with {@link onConnectionStateChange}. */
  getConnectionState = (): ConnectionState => this.state;

  /** Subscribe to connection state changes; returns the unsubscribe. */
  onConnectionStateChange = (handler: () => void): (() => void) => {
    this.stateListeners.add(handler);
    return () => this.stateListeners.delete(handler);
  };

  private isOpen(): boolean {
    return this.state === "connected" && this.ws?.readyState === WebSocket.OPEN;
  }

  private sendNow(msg: WsClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  /** Send a JSON control message, or queue it until the socket is back. */
  send(msg: WsClientMessage): void {
    if (this.isOpen()) {
      this.sendNow(msg);
    } else {
      this.pendingMessages.push(msg);
    }
  }

  /** Send terminal input as a binary frame. */
  sendTerminalInput(terminalId: string, data: string): void {
    // Input is fire-and-forget; don't queue during disconnect
    if (!this.isOpen()) return;
    const frame = encodeInputFrame(terminalId, new TextEncoder().encode(data));
    this.ws?.send(frame as BufferSource);
  }

  /** Subscribe to JSON messages (git notifications + terminal control). */
  subscribe(handler: (msg: WsMessage) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** Subscribe to raw binary terminal output for a specific terminal. */
  onTerminalOutput(terminalId: string, handler: TerminalOutputHandler): () => void {
    this.terminalOutputHandlers.set(terminalId, handler);
    return () => this.terminalOutputHandlers.delete(terminalId);
  }

  /**
   * Subscribe to reconnection events, fired once the socket is back and its worktrees are
   * re-subscribed. Listeners should re-create any other server-side state and catch up on what
   * the window missed meanwhile.
   */
  onReconnect(handler: () => void): () => void {
    this.reconnectListeners.add(handler);
    return () => this.reconnectListeners.delete(handler);
  }

  /**
   * The key of a worktree of this connection's server. A ref on another server is a caller's
   * mistake: its subscription would go to the wrong server.
   */
  private worktreeKey(wt: WorktreeRef): WorktreeRefKey {
    if (!hasConnection(wt.server)) {
      throw new Error(`Not a worktree of this connection's server: ${formatWorktreeRef(wt)}`);
    }
    return formatWorktreeRef(wt);
  }

  /** The server confirmed (or refused) the subscription of `wtPath`, a worktree it holds. */
  private confirmWorktree(wtPath: string): void {
    const key = formatWorktreeRef(localRef(wtPath));
    this.confirmedWorktrees.add(key);
    this.releaseWaiters(key);
  }

  /**
   * Subscribe to worktree events. The server creates resources on first subscription; this
   * client subscribes again by itself after a reconnect, until unsubscribed.
   */
  subscribeWorktree(wt: WorktreeRef): void {
    const key = this.worktreeKey(wt);
    // Re-adding moves it last, so the shown worktree is subscribed last after a reconnect too.
    this.worktrees.delete(key);
    this.worktrees.set(key, wt);
    if (this.isOpen()) this.sendNow({ type: "subscribe_worktree", worktreePath: wt.path });
  }

  /**
   * Unsubscribe from worktree events. The server keeps the worktree's resources for a grace period
   * after its last subscriber leaves.
   */
  unsubscribeWorktree(wt: WorktreeRef): void {
    const key = this.worktreeKey(wt);
    if (!this.worktrees.delete(key)) return;
    this.confirmedWorktrees.delete(key);
    this.releaseWaiters(key);
    if (this.isOpen()) this.sendNow({ type: "unsubscribe_worktree", worktreePath: wt.path });
  }

  /**
   * Settles once the server has the resources of `wt`, which this window subscribed to: until
   * then it answers requests for the worktree's files with 404s, on a first visit and after a
   * reconnect (to a server that may have restarted) alike. Settles at once for a worktree the
   * window is not subscribed to, and when the subscription ends or the server refuses it.
   */
  whenSubscribed(wt: WorktreeRef): Promise<void> {
    const key = this.worktreeKey(wt);
    if (!this.worktrees.has(key) || this.confirmedWorktrees.has(key)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiters = this.confirmationWaiters.get(key) ?? [];
      waiters.push(resolve);
      this.confirmationWaiters.set(key, waiters);
    });
  }

  /** Settle the {@link whenSubscribed} waits on the worktree `key`, or on every worktree. */
  private releaseWaiters(key?: WorktreeRefKey): void {
    const keys = key === undefined ? [...this.confirmationWaiters.keys()] : [key];
    for (const waited of keys) {
      const waiters = this.confirmationWaiters.get(waited);
      this.confirmationWaiters.delete(waited);
      for (const resolve of waiters ?? []) resolve();
    }
  }

  disconnect(): void {
    this.closed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.close();
    this.ws = null;
    this.pendingMessages = [];
    this.releaseWaiters();
    // A later connect waits for its hello again, and treats it as a reconnect if one came before.
    this.setState(this.server ? "reconnecting" : "connecting");
  }
}

export const wsClient = new WsClient();

/**
 * The window's own server is `id` (`fetchLocalServerId`): record it as the window's server and
 * make its connection, at the origin the window was loaded from, with `wsClient` as its socket.
 */
export function connectLocalServer(id: string): void {
  setLocalServerId(id);
  registerConnection(
    new ServerConnection({ server: localServerId(), baseUrl: LOCAL_BASE_URL, ws: wsClient }),
  );
}

/**
 * The WebSocket client of `server`'s connection, for a message about something that server holds
 * (a notification it raised, a worktree on it). One the window is not connected to is a caller's
 * mistake.
 */
export function wsClientOf(server: ServerId): WsClient {
  return connectionOf(server).ws;
}

/**
 * Whether the server refuses this window's session secret, which `GET /api/session` answers with
 * `401`. False when no server answers either: then it is down, and retrying is right.
 */
async function sessionRefused(): Promise<boolean> {
  try {
    // This socket is the window's own server's (`localConnection`).
    return (await fetch(localConnection().apiUrl("/session"))).status === 401;
  } catch {
    return false;
  }
}

// --- Version API ---

/**
 * How long to wait for the server's list of terminals. It bounds its own wait for each terminal
 * host's foreground programs at a few seconds, so this only gives up on a server that stalls: the
 * callers then fall back to what they knew without it, as for any failure.
 */
const RUNNING_TERMINALS_TIMEOUT_MS = 10_000;

/**
 * The terminals the server runs; with `programs`, each one's foreground program where its terminal
 * host can tell, which costs the host a process listing.
 */
export async function getRunningTerminals(
  server: ServerId,
  options: { programs: boolean },
): Promise<RunningTerminal[]> {
  const raw = await connectionOf(server).fetchJson<unknown>(
    options.programs ? "/terminals?programs" : "/terminals",
    { signal: AbortSignal.timeout(RUNNING_TERMINALS_TIMEOUT_MS) },
  );
  return RunningTerminalsSchema.parse(raw).terminals;
}

type VersionResponse = { version: string; isDev: boolean } & ServerIdentity;

export async function getVersion(server: ServerId): Promise<VersionResponse> {
  return connectionOf(server).fetchJson("/version");
}

const SERVER_ID_RETRY_MAX_MS = 10_000;

/**
 * The id of the server this window was loaded from, asked until it answers: the app renders only
 * once it has it (main.tsx), since every query key names it.
 */
export async function fetchLocalServerId(): Promise<string> {
  for (let delayMs = 250; ; delayMs = Math.min(delayMs * 2, SERVER_ID_RETRY_MAX_MS)) {
    try {
      // Before the window's connection exists: it is made for the server this names.
      return (await fetchApiJson<VersionResponse>(LOCAL_BASE_URL, "/version")).serverId;
    } catch (error: unknown) {
      console.warn("Could not reach the Loxel server, retrying", error);
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
}
