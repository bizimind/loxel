import type { FormattingSettings } from "@/lib/formatting-model";
import type { SchemaFileMatch } from "@/lib/schema-glob";
import type { OpenRequest, OpenResult } from "@/open-request";

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
import { BIN_MSG_OUTPUT, encodeInputFrame, parseOutputFrame } from "./terminal-stream";
import type {
  NestedRemoval,
  WorktreeRemovePlan,
  WorktreeRemoveResult,
} from "./worktree-removal-model";
import type { ServerIdentity, WsClientMessage, WsMessage } from "./ws-protocol";
import { type ConnectionState, reconnectDelay, sentAfterReconnect } from "./ws-reconnect";

const API_BASE = "/api";

/** Append wt or project scope param to a URL path. */
export function withScope(path: string, scope: { wt?: string; project?: string }): string {
  const url = new URL(`http://x${path}`);
  if (scope.wt) url.searchParams.set("wt", scope.wt);
  if (scope.project) url.searchParams.set("project", scope.project);
  return `${url.pathname}${url.search}`;
}

/** Error thrown for non-2xx API responses, with the HTTP status and the server's optional reason code. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The server confirmed the file does not exist on disk (`404` with `code: "ENOENT"`). A plain
 * 404 only means the path could not be resolved, e.g. its worktree is not subscribed yet.
 */
export function isFileMissingError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.code === "ENOENT";
}

export async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (response.status === 401) wsClient.expireSession();
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const message = typeof fields.error === "string" ? fields.error : "Request failed";
    const code = typeof fields.code === "string" ? fields.code : undefined;
    throw new ApiError(message, response.status, code);
  }

  return response.json();
}

// Store persistence (server-backed Zustand storage)
export async function getStore(key: string): Promise<string | null> {
  const { value } = await fetchJson<{ value: string | null }>(`/stores/${encodeURIComponent(key)}`);
  return value;
}

export async function putStore(
  key: string,
  value: string,
  nonce?: string,
  options?: Pick<RequestInit, "keepalive">,
): Promise<void> {
  await fetchJson(`/stores/${encodeURIComponent(key)}`, {
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
  return fetchJson<BranchCommits>(withScope(`/branch-commits${limitParam}`, { wt }));
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

/**
 * A file's content for a look only, such as a peek widget's: unlike `getFileContentByPath` it
 * neither tracks the file for renames nor adds a file outside every tree to the worktree's Others.
 */
export async function getFilePreviewContent(
  absolutePath: string,
  worktreePath?: string | null,
): Promise<{ content: string }> {
  const params = new URLSearchParams();
  params.set("path", absolutePath);
  if (worktreePath) params.set("wt", worktreePath);
  params.set("preview", "1");
  return fetchJson<{ content: string }>(`/file-content?${params.toString()}`);
}

/** The `.editorconfig` properties that apply to a file (empty when none do). */
export async function getEditorConfig(
  absolutePath: string,
  worktreePath?: string | null,
  signal?: AbortSignal,
): Promise<EditorConfigResponse> {
  const params = new URLSearchParams();
  params.set("path", absolutePath);
  if (worktreePath) params.set("wt", worktreePath);
  return fetchJson<EditorConfigResponse>(`/editorconfig?${params.toString()}`, { signal });
}

export async function writeFileContent(options: {
  path: string;
  content: string;
  nonce: string;
  worktreePath?: string;
  format?: boolean;
  formattingSettings?: FormattingSettings;
}) {
  // `formatNotice`: why a save requested with `format` went out unformatted, when the user can
  // act on it (formatter not installed, timed out).
  return fetchJson<{ success: boolean; content?: string; formatNotice?: string }>("/file-write", {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export interface DetectedFormatter {
  command: string;
  extensions: string[];
}

// "Open In" (macOS): Finder reveal and open-with-app for files Loxel manages

export async function getOpenInApps(path: string): Promise<OpenInApps> {
  return fetchJson<OpenInApps>(`/open-in/apps?path=${encodeURIComponent(path)}`);
}

/** URL of an app's icon PNG, for use as an `<img>` source. */
export function getOpenInAppIconUrl(appPath: string): string {
  return `${API_BASE}/open-in/app-icon?app=${encodeURIComponent(appPath)}`;
}

export async function revealInFinder(request: RevealInFinderRequest): Promise<void> {
  await fetchJson("/open-in/reveal", { method: "POST", body: JSON.stringify(request) });
}

export async function openWithApp(request: OpenWithAppRequest): Promise<void> {
  await fetchJson("/open-in/open", { method: "POST", body: JSON.stringify(request) });
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

/** The worktree's Others section: open folders (`isDir`), then individually opened files. */
export async function getExternalFiles(wt: string) {
  return fetchJson<DirEntry[]>(withScope("/external-files", { wt }));
}

/**
 * Send an open request (`POST /api/open`), the one the `loxel` CLI sends: for the quickstart's
 * command field, a terminal the server starts with its command typed in.
 */
export async function postOpenRequest(request: OpenRequest) {
  return fetchJson<OpenResult>("/open", { method: "POST", body: JSON.stringify(request) });
}

/** Open a folder in the worktree's Others section. Returns the root it is shown under. */
export async function addExternalFolder(wt: string, path: string) {
  return fetchJson<{ root: string }>("/external-folders/add", {
    method: "POST",
    body: JSON.stringify({ wt, path }),
  });
}

export async function removeExternalFolder(wt: string, path: string) {
  return fetchJson<{ removed: boolean }>("/external-folders/remove", {
    method: "POST",
    body: JSON.stringify({ wt, path }),
  });
}

/** Resolve a path (`~/` expanded) and report whether it is a directory. Throws when missing. */
export async function getPathInfo(path: string) {
  return fetchJson<{ path: string; isDir: boolean }>(
    `/path-info?${new URLSearchParams({ path }).toString()}`,
  );
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
  return fetchJson<{ diagnostics: TypeScriptDiagnostic[]; error?: string }>(
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

/** Discard every local change to `files` — staged, unstaged and untracked — making them match HEAD. */
export async function revertToHead(wt: string, files: string[]) {
  return fetchJson<{ success: boolean }>("/revert-to-head", {
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
  return fetchJson<ProjectsResponse>("/projects");
}

export async function addProject(req: AddProjectRequest) {
  return fetchJson<ProjectSetupResult>("/projects", { method: "POST", body: JSON.stringify(req) });
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
  return fetchJson<ProjectSetupResult>("/projects/create", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function cloneProject(req: CloneProjectRequest) {
  return fetchJson<ProjectSetupResult>("/projects/clone", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function initProject(req: InitProjectRequest) {
  return fetchJson<ProjectSetupResult>("/projects/init", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function convertProject(req: ConvertProjectRequest) {
  return fetchJson<ProjectSetupResult>("/projects/convert", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

// --- Schema API ---

export async function syncSchemas(
  schemas: Array<SchemaFileMatch & { url: string }>,
): Promise<void> {
  await fetchJson("/schemas/sync", { method: "POST", body: JSON.stringify({ schemas }) });
}

export async function ensureSchemas(urls: readonly string[]): Promise<void> {
  await fetchJson("/schemas/ensure", { method: "POST", body: JSON.stringify({ urls }) });
}

/** Record a decision on a schema URL a project file names; null forgets it. */
export async function decideSchemaConsent(
  url: string,
  decision: SchemaConsentDecision | null,
): Promise<void> {
  await fetchJson("/schemas/consent", { method: "POST", body: JSON.stringify({ url, decision }) });
}

export async function setSchemaNeverFetch(neverFetch: boolean): Promise<void> {
  await fetchJson("/schemas/never-fetch", { method: "POST", body: JSON.stringify({ neverFetch }) });
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
  InitAction as WorktreeMetadataAction,
  RemoveResult as RemoveWorktreeResult,
} from "@bizimind/wt/lib";

export async function getProjectWorktrees(projectId: string) {
  return fetchJson<ProjectWorktreesResponse>(
    `/projects/${encodeURIComponent(projectId)}/worktrees`,
  );
}

export async function planAddWorktree(projectPath: string, name: string) {
  return fetchJson<import("@bizimind/wt/lib").AddPlan>("/worktree/plan-add", {
    method: "POST",
    body: JSON.stringify({ projectPath, name }),
  });
}

/** Where a new worktree would start; with `parentPath`, also that worktree's commit. */
export async function planWorktreeBase(projectPath: string, parentPath?: string) {
  return fetchJson<WorktreeBasePlan>("/worktree/plan-base", {
    method: "POST",
    body: JSON.stringify({ projectPath, parentPath }),
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
  projectPath: string,
  name: string,
  options?: CreateWorktreeOptions,
) {
  return fetchJson<import("@bizimind/wt/lib").AddResult>("/worktree/create", {
    method: "POST",
    body: JSON.stringify({ projectPath, name, ...options }),
  });
}

/** Run the `init.wt.sh` a worktree's creation held back, once its repository is trusted. */
export async function runInitHook(projectPath: string, wtPath: string) {
  return fetchJson<{ hookRan: boolean }>("/worktree/run-init-hook", {
    method: "POST",
    body: JSON.stringify({ projectPath, path: wtPath }),
  });
}

/** Nest a worktree under another or move it to the top level (`parentPath: null`), or rename it. */
export async function updateWorktreeMeta(
  projectPath: string,
  wtPath: string,
  update: { parentPath?: string | null; title?: string | null },
) {
  return fetchJson<{ success: true }>("/worktree/meta", {
    method: "POST",
    body: JSON.stringify({ projectPath, path: wtPath, ...update }),
  });
}

/** The `wt init` action that turns on worktree metadata; null when there is nothing to do. */
export async function planEnableWorktreeMetadata(projectPath: string) {
  return fetchJson<{ action: import("@bizimind/wt/lib").InitAction | null }>(
    "/worktree/plan-enable-metadata",
    { method: "POST", body: JSON.stringify({ projectPath }) },
  );
}

export async function enableWorktreeMetadata(projectPath: string) {
  return fetchJson<{ status: "applied" | "not-needed" }>("/worktree/enable-metadata", {
    method: "POST",
    body: JSON.stringify({ projectPath }),
  });
}

export async function planRemoveWorktree(projectPath: string, wtPath: string) {
  return fetchJson<WorktreeRemovePlan>("/worktree/plan-remove", {
    method: "POST",
    body: JSON.stringify({ projectPath, path: wtPath }),
  });
}

export async function removeWorktreeByWtPath(
  projectPath: string,
  wtPath: string,
  options: {
    deleteBranch: boolean;
    force: boolean;
    nested?: NestedRemoval;
    /** With `nested: "remove"`: the nested worktrees the user confirmed removing */
    nestedPaths?: string[];
  },
) {
  return fetchJson<WorktreeRemoveResult>("/worktree/remove", {
    method: "POST",
    body: JSON.stringify({ projectPath, path: wtPath, ...options }),
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

// Terminal output handler: receives raw PTY bytes for a specific terminal, tagged with the
// stream offset of their first byte.
type TerminalOutputHandler = (offset: number, data: Uint8Array) => void;

/** What reconnect listeners learn about the server the socket reconnected to. */
export interface ReconnectInfo {
  /** A new server process (its boot epoch changed), which kept nothing in memory from before. */
  serverRestarted: boolean;
}

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
  private reconnectListeners = new Set<(info: ReconnectInfo) => void>();
  private stateListeners = new Set<() => void>();
  private terminalOutputHandlers = new Map<string, TerminalOutputHandler>();
  private pendingMessages: WsClientMessage[] = [];
  /** The worktrees this window is subscribed to, in order: the server takes the last as shown. */
  private worktrees = new Set<string>();

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
    postLogEntry({ level: "warn", cat: "server", msg: "The server no longer accepts this window" });
    this.closed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
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
   * different server reloads the page to pick up its renderer and state. Otherwise the window
   * re-creates its per-connection state on the server and catches up: the boot epoch tells the
   * listeners whether the server restarted or this was only the socket.
   */
  private handleHello(hello: ServerHello): void {
    const previous = this.server;
    if (previous && (hello.version !== previous.version || hello.serverId !== previous.serverId)) {
      postLogEntry({
        level: "info",
        cat: "server",
        msg: "Server changed, reloading",
        ctx: {
          oldVersion: previous.version,
          newVersion: hello.version,
          sameServer: hello.serverId === previous.serverId,
        },
      });
      window.location.reload();
      return;
    }
    this.server = hello;
    this.attempt = 0;
    for (const worktreePath of this.worktrees) {
      this.sendNow({ type: "subscribe_worktree", worktreePath });
    }
    const queued = this.pendingMessages;
    this.pendingMessages = [];
    this.setState("connected");

    if (!previous) {
      for (const msg of queued) this.sendNow(msg);
      return;
    }
    const serverRestarted = hello.bootEpoch !== previous.bootEpoch;
    postLogEntry({
      level: "info",
      cat: "server",
      msg: serverRestarted ? "Reconnected to a restarted server" : "Reconnected",
    });
    for (const listener of this.reconnectListeners) {
      try {
        listener({ serverRestarted });
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
  onReconnect(handler: (info: ReconnectInfo) => void): () => void {
    this.reconnectListeners.add(handler);
    return () => this.reconnectListeners.delete(handler);
  }

  /**
   * Subscribe to worktree events. The server creates resources on first subscription; this
   * client subscribes again by itself after a reconnect, until unsubscribed.
   */
  subscribeWorktree(worktreePath: string): void {
    // Re-adding moves it last, so the shown worktree is subscribed last after a reconnect too.
    this.worktrees.delete(worktreePath);
    this.worktrees.add(worktreePath);
    if (this.isOpen()) this.sendNow({ type: "subscribe_worktree", worktreePath });
  }

  /**
   * Unsubscribe from worktree events. The server keeps the worktree's resources for a grace period
   * after its last subscriber leaves.
   */
  unsubscribeWorktree(worktreePath: string): void {
    if (!this.worktrees.delete(worktreePath)) return;
    if (this.isOpen()) this.sendNow({ type: "unsubscribe_worktree", worktreePath });
  }

  disconnect(): void {
    this.closed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.close();
    this.ws = null;
    this.pendingMessages = [];
    // A later connect waits for its hello again, and treats it as a reconnect if one came before.
    this.setState(this.server ? "reconnecting" : "connecting");
  }
}

export const wsClient = new WsClient();

/**
 * Whether the server refuses this window's session secret, which `GET /api/session` answers with
 * `401`. False when no server answers either: then it is down, and retrying is right.
 */
async function sessionRefused(): Promise<boolean> {
  try {
    return (await fetch(`${API_BASE}/session`)).status === 401;
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
export async function getRunningTerminals(options: {
  programs: boolean;
}): Promise<RunningTerminal[]> {
  const raw = await fetchJson<unknown>(options.programs ? "/terminals?programs" : "/terminals", {
    signal: AbortSignal.timeout(RUNNING_TERMINALS_TIMEOUT_MS),
  });
  return RunningTerminalsSchema.parse(raw).terminals;
}

export async function getVersion(): Promise<{ version: string; isDev: boolean } & ServerIdentity> {
  return fetchJson("/version");
}
