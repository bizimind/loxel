import type { FormattingSettings } from "@/lib/formatting-model";

import type { TsgoDiagnostic } from "./diagnostics-model";
import type { DiffInfo } from "./diff-model";
import type {
  BranchInfo,
  CommitInfo,
  GraphData,
  RefInfo,
  StatusInfo,
  WorktreeEntry,
  WorktreeStatusInfo,
} from "./git-models";
import type { LogEntry } from "./log-entry-model";
import type { DirEntry } from "./project-files-model";
import type {
  BrowseEntry,
  CloneProjectRequest,
  ConvertProjectRequest,
  CreateProjectRequest,
  DetectPathResult,
  EnrichedProject,
  InitProjectRequest,
  Project,
  ScanSuggestionsResult,
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
import type { UpdateState } from "./update-model";
import type { WsClientMessage, WsMessage } from "./ws-protocol";

import {
  BIN_HEADER_SIZE,
  BIN_MSG_INPUT,
  BIN_MSG_OUTPUT,
  encodeBinaryFrame,
  parseBinaryHeader,
} from "./ws-protocol";

const API_BASE = "/api";

/** Append wt or project scope param to a URL path. */
function withScope(path: string, scope: { wt?: string; project?: string }): string {
  const url = new URL(`http://x${path}`);
  if (scope.wt) url.searchParams.set("wt", scope.wt);
  if (scope.project) url.searchParams.set("project", scope.project);
  return `${url.pathname}${url.search}`;
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || "Request failed");
  }

  return response.json();
}

// Store persistence (server-backed Zustand storage)
export async function getStore(key: string): Promise<string | null> {
  const { value } = await fetchJson<{ value: string | null }>(`/stores/${encodeURIComponent(key)}`);
  return value;
}

export async function putStore(key: string, value: string, nonce?: string): Promise<void> {
  await fetchJson(`/stores/${encodeURIComponent(key)}`, {
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
  // Fire-and-forget — logging should never block the UI
  fetch(`${API_BASE}/log`, {
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
  return fetchJson(`/logs${query ? `?${query}` : ""}`);
}

export async function getLog(wt: string, options?: LogQueryOptions) {
  return fetchJson<CommitInfo[]>(withScope(`/log${buildLogParams(options)}`, { wt }));
}

export async function getGraph(wt: string, options?: LogQueryOptions) {
  return fetchJson<GraphData>(withScope(`/graph${buildLogParams(options)}`, { wt }));
}

export async function getBranchCommits(wt: string, options?: { limit?: number }) {
  const limitParam = options?.limit ? `?limit=${options.limit}` : "";
  return fetchJson<{ commits: CommitInfo[]; mergeBase: string | null }>(
    withScope(`/branch-commits${limitParam}`, { wt }),
  );
}

export async function getStatus(wt: string) {
  return fetchJson<StatusInfo>(withScope("/status", { wt }));
}

export async function getDiff(
  wt: string,
  options?: { staged?: boolean; commit?: string; range?: string; worktree?: string; base?: string },
) {
  const params = new URLSearchParams();
  params.set("wt", wt);
  if (options?.staged) params.set("staged", "true");
  if (options?.commit) params.set("commit", options.commit);
  if (options?.range) params.set("range", options.range);
  if (options?.worktree) params.set("worktree", options.worktree);
  if (options?.base) params.set("base", options.base);

  const query = params.toString();
  return fetchJson<DiffInfo>(`/diff${query ? `?${query}` : ""}`);
}

export async function getBranches(wt: string) {
  return fetchJson<BranchInfo[]>(withScope("/branches", { wt }));
}

export async function getRecentBranchNames(wt: string, days: number) {
  return fetchJson<string[]>(withScope(`/branches/recent?days=${days}`, { wt }));
}

export async function getRefs(wt: string) {
  return fetchJson<RefInfo[]>(withScope("/refs", { wt }));
}

export async function getFileLines(
  wt: string,
  options: { path: string; startLine: number; endLine: number; ref?: string },
) {
  const params = new URLSearchParams();
  params.set("wt", wt);
  params.set("path", options.path);
  params.set("startLine", String(options.startLine));
  params.set("endLine", String(options.endLine));
  if (options.ref) params.set("ref", options.ref);

  return fetchJson<{ lines: string[] }>(`/file-lines?${params.toString()}`);
}

export async function getFileContent(options: {
  path: string;
  ref?: string;
  worktree?: string;
  wt?: string;
}) {
  const params = new URLSearchParams();
  params.set("path", options.path);
  if (options.ref) params.set("ref", options.ref);
  if (options.worktree) params.set("worktree", options.worktree);
  if (options.wt) params.set("wt", options.wt);

  return fetchJson<{ lines: string[] }>(`/file-content?${params.toString()}`);
}

/** Read file content by absolute path. Used by editors (returns content as string, not lines). */
export async function getFileContentByPath(
  absolutePath: string,
  worktreePath?: string | null,
  signal?: AbortSignal,
): Promise<{ content: string }> {
  const params = new URLSearchParams();
  params.set("path", absolutePath);
  if (worktreePath) params.set("wt", worktreePath);
  return fetchJson<{ content: string }>(`/file-content?${params.toString()}`, { signal });
}

export async function writeFileContent(options: {
  path: string;
  content: string;
  nonce: string;
  worktreePath?: string;
  format?: boolean;
  formattingSettings?: FormattingSettings;
}) {
  return fetchJson<{ success: boolean; content?: string }>("/file-write", {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export interface DetectedFormatter {
  command: string;
  extensions: string[];
}

export async function getDetectedFormatters(worktreePath: string): Promise<DetectedFormatter[]> {
  const params = new URLSearchParams({ wt: worktreePath });
  const result = await fetchJson<{ formatters: DetectedFormatter[] }>(
    `/detected-formatters?${params.toString()}`,
  );
  return result.formatters;
}

// --- Full-text search ---

export async function search(
  wt: string,
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
  params.set("wt", wt);
  params.set("q", options.q);
  if (options.regex) params.set("regex", "true");
  if (options.caseSensitive) params.set("caseSensitive", "true");
  if (options.wholeWord) params.set("wholeWord", "true");
  if (options.maxResults) params.set("maxResults", String(options.maxResults));
  if (options.scope && options.scope !== "all") params.set("scope", options.scope);
  if (options.paths?.length) params.set("paths", options.paths.join(","));
  if (options.globs?.length) params.set("globs", options.globs.join(","));
  return fetchJson<import("./search-model").SearchResponse>(`/search?${params.toString()}`, {
    signal,
  });
}

export async function getSearchScopes(wt: string) {
  return fetchJson<{
    packages: Array<import("@/components/search/search-scope-model").WorkspacePackage>;
    dirs: string[];
    extensions: string[];
  }>(withScope("/search-scopes", { wt }));
}

export async function getFileIndex(wt: string) {
  return fetchJson<import("@/store/file-search").FileIndexEntry>(withScope("/file-index", { wt }));
}

// --- Detached files (drafts) ---

export async function getDetachedFiles(wt: string) {
  return fetchJson<DirEntry[]>(withScope("/detached-files", { wt }));
}

export async function getExternalFiles(wt: string) {
  return fetchJson<DirEntry[]>(withScope("/external-files", { wt }));
}

export async function createDetachedFile(options: {
  wt: string;
  prefix: string;
  ext?: string;
  content?: string;
}) {
  return fetchJson<{ name: string; path: string }>("/detached-file-create", {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function moveDetachedFileToProject(options: {
  wt: string;
  path: string;
  destPath: string;
}) {
  return fetchJson<{ newPath: string }>("/detached-file-move", {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function deleteDetachedFile(wt: string, path: string) {
  return fetchJson<{ success: boolean }>("/detached-file-delete", {
    method: "POST",
    body: JSON.stringify({ wt, path }),
  });
}

export async function renameDetachedFile(wt: string, path: string, newName: string) {
  return fetchJson<{ success: boolean }>("/detached-file-rename", {
    method: "POST",
    body: JSON.stringify({ wt, path, newName }),
  });
}

export async function copyDetachedFileToProject(options: {
  wt: string;
  path: string;
  destPath: string;
}) {
  return fetchJson<{ newPath: string }>("/detached-file-copy-to-project", {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function getWorktreeStatuses(wt: string) {
  return fetchJson<WorktreeStatusInfo[]>(withScope("/worktree-statuses", { wt }));
}

export async function getDiagnostics(wt: string, ref?: string, worktree?: string) {
  const params = new URLSearchParams();
  params.set("wt", wt);
  if (ref) params.set("ref", ref);
  if (worktree) params.set("worktree", worktree);
  const query = params.toString();
  return fetchJson<{ diagnostics: TsgoDiagnostic[]; error?: string }>(
    `/diagnostics${query ? `?${query}` : ""}`,
  );
}

// POST endpoints — all accept worktreePath to identify scope
export async function stageFiles(wt: string, files: string[]) {
  return fetchJson<{ success: boolean }>("/stage", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt, files }),
  });
}

export async function unstageFiles(wt: string, files: string[]) {
  return fetchJson<{ success: boolean }>("/unstage", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt, files }),
  });
}

export async function createCommit(wt: string, message: string) {
  return fetchJson<{ commit: string }>("/commit", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt, message }),
  });
}

export async function checkout(wt: string, ref: string) {
  return fetchJson<{ success: boolean }>("/checkout", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt, ref }),
  });
}

export async function reset(wt: string, commit: string, mode: "soft" | "mixed" | "hard") {
  return fetchJson<{ success: boolean }>("/reset", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt, commit, mode }),
  });
}

export async function cherryPick(wt: string, commits: string[]) {
  return fetchJson<{ success: boolean }>("/cherry-pick", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt, commits }),
  });
}

export async function revert(wt: string, commits: string[]) {
  return fetchJson<{ success: boolean }>("/revert", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt, commits }),
  });
}

export async function createBranch(wt: string, name: string, startPoint?: string) {
  return fetchJson<{ success: boolean }>("/branch/create", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt, name, startPoint }),
  });
}

export async function deleteBranch(wt: string, name: string, force?: boolean) {
  return fetchJson<{ success: boolean }>("/branch/delete", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt, name, force }),
  });
}

export async function renameBranch(wt: string, oldName: string, newName: string) {
  return fetchJson<{ success: boolean }>("/branch/rename", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt, oldName, newName }),
  });
}

export async function discardChanges(wt: string, files: string[]) {
  return fetchJson<{ success: boolean }>("/discard", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt, files }),
  });
}

export async function stageHunk(wt: string, patch: string) {
  return fetchJson<{ success: boolean }>("/stage-hunk", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt, patch }),
  });
}

export async function unstageHunk(wt: string, patch: string) {
  return fetchJson<{ success: boolean }>("/unstage-hunk", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt, patch }),
  });
}

// --- Project API ---

export async function getProjects() {
  return fetchJson<{ projects: EnrichedProject[] }>("/projects");
}

export async function addProject(path: string, name?: string) {
  return fetchJson<Project>("/projects", { method: "POST", body: JSON.stringify({ path, name }) });
}

export async function removeProject(id: string) {
  return fetchJson<{ success: boolean }>(`/projects/${id}`, { method: "DELETE" });
}

export async function deleteProject(id: string) {
  return fetchJson<{ success: boolean }>(`/projects/${id}/delete`, { method: "POST" });
}

export async function updateProject(id: string, updates: { name?: string }) {
  return fetchJson<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(updates) });
}

export async function browse(path?: string) {
  const params = path ? `?path=${encodeURIComponent(path)}` : "";
  return fetchJson<{ path: string; dirs: BrowseEntry[] }>(`/browse${params}`);
}

export type { BrowseEntry };

// --- Add Project Wizard API ---

export async function detectPath(path: string) {
  return fetchJson<DetectPathResult>("/projects/detect", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export async function scanSuggestions(path: string) {
  return fetchJson<ScanSuggestionsResult>(
    `/projects/scan-suggestions?path=${encodeURIComponent(path)}`,
  );
}

export async function createProject(req: CreateProjectRequest) {
  return fetchJson<Project>("/projects/create", { method: "POST", body: JSON.stringify(req) });
}

export async function cloneProject(req: CloneProjectRequest) {
  return fetchJson<Project>("/projects/clone", { method: "POST", body: JSON.stringify(req) });
}

export async function initProject(req: InitProjectRequest) {
  return fetchJson<Project>("/projects/init", { method: "POST", body: JSON.stringify(req) });
}

export async function convertProject(req: ConvertProjectRequest) {
  return fetchJson<Project>("/projects/convert", { method: "POST", body: JSON.stringify(req) });
}

// --- Wt config API ---

export async function getWtConfigRaw(projectId: string) {
  return fetchJson<{ content: string }>(
    `/wt-config-raw?projectId=${encodeURIComponent(projectId)}`,
  );
}

export async function saveWtConfigRaw(projectId: string, content: string) {
  return fetchJson<{ success: boolean }>("/wt-config-save", {
    method: "POST",
    body: JSON.stringify({ projectId, content }),
  });
}

export async function getWtJsonSchema() {
  return fetchJson<object>("/wt-json-schema");
}

// --- Schema API ---

export interface SchemaSyncResult {
  json: Array<{ glob: string; url: string; schema: unknown }>;
  yaml: { synced: boolean };
}

export async function syncSchemas(
  schemas: Array<{ glob: string; url: string }>,
): Promise<SchemaSyncResult> {
  return fetchJson<SchemaSyncResult>("/schemas/sync", {
    method: "POST",
    body: JSON.stringify({ schemas }),
  });
}

export async function resolveSchema(url: string, baseDir?: string): Promise<unknown> {
  const params = new URLSearchParams({ url });
  if (baseDir) params.set("baseDir", baseDir);
  try {
    return await fetchJson<unknown>(`/schemas/resolve?${params.toString()}`);
  } catch {
    return null;
  }
}

// --- Worktree API ---

export type { AddPlan as AddWorktreePlan, AddResult as AddWorktreeResult } from "@bizimind/wt/lib";
export type {
  RemovePlan as RemoveWorktreePlan,
  RemoveResult as RemoveWorktreeResult,
} from "@bizimind/wt/lib";

export async function getProjectWorktrees(projectId: string) {
  return fetchJson<{ worktrees: WorktreeEntry[] }>(
    `/projects/${encodeURIComponent(projectId)}/worktrees`,
  );
}

export async function planAddWorktree(projectPath: string, name: string) {
  return fetchJson<import("@bizimind/wt/lib").AddPlan>("/worktree/plan-add", {
    method: "POST",
    body: JSON.stringify({ projectPath, name }),
  });
}

export async function createWorktree(
  projectPath: string,
  name: string,
  options?: { branch?: string; branchResolution?: "use-existing" | "delete-and-create" },
) {
  return fetchJson<import("@bizimind/wt/lib").AddResult | { success: boolean }>(
    "/worktree/create",
    { method: "POST", body: JSON.stringify({ projectPath, name, ...options }) },
  );
}

export async function planRemoveWorktree(projectPath: string, wtPath: string) {
  return fetchJson<import("@bizimind/wt/lib").RemovePlan>("/worktree/plan-remove", {
    method: "POST",
    body: JSON.stringify({ projectPath, path: wtPath }),
  });
}

export async function removeWorktreeByWtPath(
  projectPath: string,
  wtPath: string,
  options: { deleteBranch: boolean; force: boolean },
) {
  return fetchJson<import("@bizimind/wt/lib").RemoveResult>("/worktree/remove", {
    method: "POST",
    body: JSON.stringify({
      projectPath,
      path: wtPath,
      deleteBranch: options.deleteBranch,
      force: options.force,
    }),
  });
}

export async function removeWorktreeByPath(projectPath: string, path: string, force?: boolean) {
  return fetchJson<{ success: boolean }>("/worktree/remove", {
    method: "POST",
    body: JSON.stringify({ projectPath, path, force }),
  });
}

// --- Project file operations ---

import type { FileOperationResult } from "./file-operations-model";

export async function createProjectFile(wt: string, options: { dir: string; name?: string }) {
  return fetchJson<{ path: string }>("/files/create-file", {
    method: "POST",
    body: JSON.stringify({ wt, ...options }),
  });
}

export async function createProjectDir(wt: string, options: { dir: string; name?: string }) {
  return fetchJson<{ path: string }>("/files/create-dir", {
    method: "POST",
    body: JSON.stringify({ wt, ...options }),
  });
}

export async function copyProjectFile(wt: string, options: { srcPath: string; destDir: string }) {
  return fetchJson<{ newPath: string }>("/files/copy", {
    method: "POST",
    body: JSON.stringify({ wt, ...options }),
  });
}

export async function renameProjectFile(wt: string, options: { path: string; newName: string }) {
  return fetchJson<{ newPath: string }>("/files/rename", {
    method: "POST",
    body: JSON.stringify({ wt, ...options }),
  });
}

export async function deleteProjectFile(wt: string, path: string) {
  return fetchJson<{ success: boolean }>("/files/delete", {
    method: "POST",
    body: JSON.stringify({ wt, path }),
  });
}

export async function moveProjectFile(wt: string, options: { srcPath: string; destDir: string }) {
  return fetchJson<{ newPath: string }>("/files/move", {
    method: "POST",
    body: JSON.stringify({ wt, ...options }),
  });
}

export async function undoFileOperation(wt: string) {
  return fetchJson<{ result: FileOperationResult | null }>("/files/undo", {
    method: "POST",
    body: JSON.stringify({ wt }),
  });
}

export async function redoFileOperation(wt: string) {
  return fetchJson<{ result: FileOperationResult | null }>("/files/redo", {
    method: "POST",
    body: JSON.stringify({ wt }),
  });
}

// --- Project files API ---

export async function getDirContents(wt: string, dir: string) {
  const params = new URLSearchParams();
  params.set("wt", wt);
  if (dir) params.set("dir", dir);
  return fetchJson<DirEntry[]>(`/files?${params.toString()}`);
}

export function unwatchDir(wt: string, dir: string) {
  // Fire-and-forget — no need to await cleanup
  fetch(`${API_BASE}/files/unwatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wt, dir }),
  }).catch(() => {});
}

// --- Review API ---

export async function getReviews(wt: string) {
  return fetchJson<Review[]>(withScope("/reviews", { wt }));
}

export async function createReview(wt: string, data: CreateReviewRequest) {
  return fetchJson<Review>(withScope("/reviews", { wt }), {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateReview(wt: string, id: string, updates: { name?: string }) {
  return fetchJson<Review>(withScope(`/reviews/${id}`, { wt }), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteReview(wt: string, id: string) {
  return fetchJson<{ success: boolean }>(withScope(`/reviews/${id}`, { wt }), { method: "DELETE" });
}

// --- Placed threads (server-side placement) ---

export async function postPlacedThreads(wt: string, reviewIds: string[], files: DiffFileContext[]) {
  return fetchJson<PlacedThread[]>(withScope("/placed-threads", { wt }), {
    method: "POST",
    body: JSON.stringify({ reviewIds, files }),
  });
}

// --- Thread mutations ---

export async function createCommentThread(wt: string, data: CreateThreadRequest) {
  return fetchJson<CommentThread>(withScope("/comments/threads", { wt }), {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function addCommentReply(wt: string, threadId: string, body: string) {
  return fetchJson<Comment>(withScope(`/comments/threads/${threadId}/comments`, { wt }), {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function updateCommentThread(
  wt: string,
  threadId: string,
  status: "open" | "resolved",
) {
  return fetchJson<CommentThread>(withScope(`/comments/threads/${threadId}`, { wt }), {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export async function deleteCommentThread(wt: string, threadId: string) {
  return fetchJson<{ success: boolean }>(withScope(`/comments/threads/${threadId}`, { wt }), {
    method: "DELETE",
  });
}

// Terminal output handler: receives raw PTY bytes for a specific terminal
type TerminalOutputHandler = (data: Uint8Array) => void;

// WebSocket singleton client with send support
class WsClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private wasConnected = false;
  private knownVersion: string | null = null;
  private listeners = new Set<(msg: WsMessage) => void>();
  private reconnectListeners = new Set<() => void>();
  private terminalOutputHandlers = new Map<string, TerminalOutputHandler>();
  private terminalDataListeners = new Set<(terminalId: string, data: Uint8Array) => void>();
  private pendingMessages: (string | ArrayBuffer)[] = [];

  connect(): void {
    this.closed = false;
    this.doConnect();
  }

  private doConnect(): void {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      postLogEntry({ level: "info", cat: "server", msg: "WebSocket connected" });
      this.ws = ws;

      if (this.wasConnected) {
        // Server came back — check if it was updated (version changed → full page reload)
        this.checkVersionAndRecover();
      } else {
        // First connection: record server version and flush pending messages
        this.recordVersion();
        for (const msg of this.pendingMessages) {
          ws.send(msg);
        }
        this.pendingMessages = [];
        this.wasConnected = true;
      }
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        // JSON text frame — control/git messages
        try {
          const raw: unknown = JSON.parse(event.data);
          if (typeof raw !== "object" || raw === null || !("type" in raw)) return;
          const message = raw as WsMessage;
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
        // Binary frame — terminal I/O
        const buf = new Uint8Array(event.data as ArrayBuffer);
        if (buf.byteLength < BIN_HEADER_SIZE) return;

        const { type, terminalId } = parseBinaryHeader(buf);
        if (type === BIN_MSG_OUTPUT) {
          const payload = buf.subarray(BIN_HEADER_SIZE);
          const handler = this.terminalOutputHandlers.get(terminalId);
          if (typeof handler === "function") handler(payload);
          for (const listener of this.terminalDataListeners) {
            listener(terminalId, payload);
          }
        }
      }
    };

    ws.onclose = () => {
      postLogEntry({ level: "warn", cat: "server", msg: "WebSocket disconnected" });
      this.ws = null;
      if (!this.closed) {
        setTimeout(() => this.doConnect(), 2000);
      }
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

  /** Record the server version on first successful connection. */
  private async recordVersion(): Promise<void> {
    try {
      const { version } = await getVersion();
      this.knownVersion = version;
    } catch {
      /* best effort */
    }
  }

  /**
   * On reconnect, compare the server version to the one recorded at first connect.
   * If the version changed (update installed), reload the page to pick up new renderer
   * assets. Otherwise, fire reconnect listeners for normal recovery (terminal reattach, etc.).
   */
  private async checkVersionAndRecover(): Promise<void> {
    this.pendingMessages = [];

    try {
      const { version } = await getVersion();
      if (this.knownVersion && version !== this.knownVersion) {
        postLogEntry({
          level: "info",
          cat: "server",
          msg: "Server version changed, reloading",
          ctx: { oldVersion: this.knownVersion, newVersion: version },
        });
        window.location.reload();
        return;
      }
      this.knownVersion = version;
    } catch {
      /* server may still be starting — fall through to normal reconnect */
    }

    // Version unchanged or check failed — normal reconnect
    for (const listener of this.reconnectListeners) {
      listener();
    }
  }

  /** Send a JSON control message. */
  send(msg: WsClientMessage): void {
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.pendingMessages.push(data);
    }
  }

  /** Send terminal input as a binary frame. */
  sendTerminalInput(terminalId: string, data: string): void {
    const frame = encodeBinaryFrame(BIN_MSG_INPUT, terminalId, new TextEncoder().encode(data));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frame as BufferSource);
    }
    // Input is fire-and-forget; don't queue during disconnect
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

  /** Whether a primary output handler is registered for a terminal (i.e. xterm.js is mounted). */
  hasTerminalHandler(terminalId: string): boolean {
    return this.terminalOutputHandlers.has(terminalId);
  }

  /** Subscribe to all terminal output for notification scanning. */
  onTerminalData(handler: (terminalId: string, data: Uint8Array) => void): () => void {
    this.terminalDataListeners.add(handler);
    return () => this.terminalDataListeners.delete(handler);
  }

  /** Subscribe to reconnection events. Listeners should re-create any server-side state. */
  onReconnect(handler: () => void): () => void {
    this.reconnectListeners.add(handler);
    return () => this.reconnectListeners.delete(handler);
  }

  /** Subscribe to worktree events. Server creates resources on first subscription. */
  subscribeWorktree(worktreePath: string): void {
    this.send({ type: "subscribe_worktree", worktreePath });
  }

  /** Unsubscribe from worktree events. Server tears down resources when no subscribers remain. */
  unsubscribeWorktree(worktreePath: string): void {
    this.send({ type: "unsubscribe_worktree", worktreePath });
  }

  disconnect(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    this.pendingMessages = [];
  }
}

export const wsClient = new WsClient();

// --- Update API ---

export async function getVersion(): Promise<{ version: string; isDev: boolean }> {
  return fetchJson("/version");
}

export async function getUpdateStatus(): Promise<UpdateState> {
  return fetchJson("/update/status");
}

export async function checkForUpdate(): Promise<UpdateState> {
  return fetchJson("/update/check", { method: "POST" });
}

export async function downloadUpdate(): Promise<UpdateState> {
  return fetchJson("/update/download", { method: "POST" });
}

export async function installUpdate(): Promise<void> {
  await fetchJson("/update/install", { method: "POST" });
}
