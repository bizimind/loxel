import {
  planAdd,
  executeAdd,
  planRemove,
  executeRemove,
  WT_CONFIG_JSON_SCHEMA,
  getWorktreeName,
  listManagedWorktrees,
  detectRepoType,
  hasUncommittedChanges,
  getCurrentBranch,
  initBareRepo,
  transformToBare,
  ensureWorktreesDir,
  writeWtYaml,
  type AddPlan,
  type ProgressHandler,
  type RemovePlan,
} from "@bizimind/wt/lib";
import { accessSync, constants, existsSync, mkdirSync, readdirSync } from "node:fs";
import { realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

import type { DiffInfo } from "@/api/diff-model";
import type { FileOperationResult } from "@/api/file-operations-model";
import type { LogCategory, LogLevel } from "@/api/log-entry-model";
import type {
  BrowseEntry,
  DetectPathResult,
  ScanSuggestionsResult,
  WorkspaceSetup,
} from "@/api/project-model";
import type { SearchMatch } from "@/api/search-model";
import type { WsMessage } from "@/api/ws-protocol";
import type { FormatterOverride, FormattingSettings } from "@/lib/formatting-model";

import { LOG_CATEGORIES, LOG_LEVEL_PRIORITY } from "@/api/log-entry-model";
import { repoNameFromUrl } from "@/components/projects/wizard-detection";
import { getMediaType } from "@/lib/media-extensions";
import { isHttpUrl } from "@/url-utils";

import type { ProjectState, ResolvedFilePath, WorktreeResources } from "./server-state";

import { config } from "./config";
import { getDiagnostics } from "./diagnostics";
import * as git from "./git-commands";
import { handleLocalDbRequest } from "./localdb-routes";
import { logger } from "./logger";
import * as projectStore from "./project-store";
import { error, json } from "./response-helpers";
import { handleReviewRequest } from "./review-routes";
import { decrypt, encrypt, isEncrypted } from "./secret-store";
import { buildSpawnEnv } from "./shell-env";
import * as storeDb from "./store-db";
import { stress } from "./stress-detector";
import { checkForUpdate, downloadUpdate, getUpdateStatus, prepareInstall } from "./update";
import { getCurrentVersion } from "./version";
import { INTERNAL_WORKTREE_PREFIX, findWorkspacePackages } from "./worktree-utils";
import { worktreesChangedMessage } from "./ws-messages";

const wtLog = logger.child("worktrees");
const searchLog = logger.child("search");

const wtProgress: ProgressHandler = {
  log: (msg) => wtLog.info(msg),
  warn: (msg) => wtLog.warn(msg),
};

export interface RouteContext {
  broadcastToSubscribers: (wtPath: string, msg: WsMessage) => void;
  broadcastToProject: (projectPath: string, msg: WsMessage) => void;
  broadcastAll: (msg: WsMessage) => void;
  getProject: (cwd: string) => ProjectState | undefined;
  findProjectForPath: (path: string) => ProjectState | undefined;
  getWorktreeResources: (wtPath: string) => WorktreeResources | undefined;
  /** Resolve an absolute file path to its owning worktree and service type. */
  resolveFilePath: (absolutePath: string) => ResolvedFilePath | null;
  initializeProject: (repoPath: string) => Promise<{ project: ProjectState; worktrees: unknown[] }>;
  teardownProject: (cwd: string) => void;
  shutdown: (exitCode?: number) => void;
  /** Resolve a schema URL or file path (with caching). */
  resolveSchema: (urlOrPath: string, baseDir?: string) => Promise<unknown>;
  /** Update YAML LSP schema mappings on all active sessions. */
  updateYamlSchemas: (schemaMap: Record<string, string[]>) => void;
  /** Format file content using the resolved formatter. */
  formatContent: (
    content: string,
    filePath: string,
    worktreePath: string | undefined,
    settings: FormattingSettings,
  ) => Promise<string | null>;
  /** Return detected formatters for a worktree. */
  getDetectedFormatters: (worktreePath: string) => { command: string; extensions: string[] }[];
}

type RouteHandler = (req: Request, ctx: RouteContext) => Promise<Response> | Response;

// ---------------------------------------------------------------------------
// Param resolution helpers
// ---------------------------------------------------------------------------

/**
 * Try to resolve a file path, auto-registering it as an external file if the client
 * provided a worktree hint. This self-heals when in-memory registrations are lost
 * (e.g. after a server restart) but the client still has the file open.
 */
function resolveFilePathWithHint(
  ctx: RouteContext,
  filePath: string,
  worktreeHint: string | null | undefined,
  requireExists = true,
): ResolvedFilePath | null {
  const resolved = ctx.resolveFilePath(filePath);
  if (resolved) return resolved;
  if (!worktreeHint) return null;
  const resources = ctx.getWorktreeResources(worktreeHint);
  if (!resources) return null;
  if (requireExists && !existsSync(filePath)) return null;
  resources.externalFilesService.addFile(filePath);
  return ctx.resolveFilePath(filePath);
}

function resolveProjectFromReq(
  req: Request,
  ctx: RouteContext,
): { project: ProjectState; cwd: string } | Response {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get("project");
  const wtPath = url.searchParams.get("wt");
  const lookupPath = projectPath ?? wtPath;
  if (!lookupPath) return error("Missing project or wt parameter", 400);
  const project = ctx.findProjectForPath(lookupPath);
  if (!project) return error("Project not found", 404);
  return { project, cwd: project.cwd };
}

function resolveWorktreeFromReq(
  req: Request,
  ctx: RouteContext,
): { project: ProjectState; cwd: string; wtPath: string } | Response {
  const url = new URL(req.url);
  const wtPath = url.searchParams.get("wt");
  if (!wtPath) return error("Missing wt parameter", 400);
  const project = ctx.findProjectForPath(wtPath);
  if (!project) return error("Project not found", 404);
  return { project, cwd: project.cwd, wtPath };
}

function resolveProjectFromBody(
  body: Record<string, unknown>,
  ctx: RouteContext,
  pathField = "worktreePath",
): { project: ProjectState; cwd: string; wtPath: string } | Response {
  const wtPath = body[pathField];
  if (typeof wtPath !== "string") return error(`Missing ${pathField} in body`, 400);
  const project = ctx.findProjectForPath(wtPath);
  if (!project) return error("Project not found", 404);
  return { project, cwd: project.cwd, wtPath };
}

// ---------------------------------------------------------------------------
// Body parsing helpers
// ---------------------------------------------------------------------------

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function requireStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`${field} must be a string array`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Settings encryption — encrypt/decrypt apiKey fields in model entries
// ---------------------------------------------------------------------------

/** Store keys ending with this suffix contain model API keys that must be encrypted at rest. */
const ENCRYPTED_STORE_SUFFIX = "-settings";

function isEncryptedStoreKey(storeKey: string): boolean {
  return storeKey.endsWith(ENCRYPTED_STORE_SUFFIX);
}

function transformModelKeys(jsonStr: string, transform: (apiKey: string) => string): string {
  const parsed: unknown = JSON.parse(jsonStr);
  if (typeof parsed !== "object" || parsed === null) return jsonStr;
  const state = (parsed as Record<string, unknown>).state;
  if (typeof state !== "object" || state === null) return jsonStr;
  const models = (state as Record<string, unknown>).models;
  if (!Array.isArray(models)) return jsonStr;
  for (const model of models) {
    if (
      typeof model === "object" &&
      model !== null &&
      typeof model.apiKey === "string" &&
      model.apiKey
    ) {
      model.apiKey = transform(model.apiKey);
    }
  }
  return JSON.stringify(parsed);
}

function encryptModelKeys(jsonStr: string): string {
  return transformModelKeys(jsonStr, (v) => (isEncrypted(v) ? v : encrypt(v)));
}

function decryptModelKeys(jsonStr: string): string {
  return transformModelKeys(jsonStr, decrypt);
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

/** Validate and narrow the formatting settings from the request body. */
function parseFormattingSettings(raw: unknown): FormattingSettings | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.enabled !== "boolean" || typeof obj.autoDetect !== "boolean") return undefined;
  if (!Array.isArray(obj.overrides)) return undefined;
  // Validate each override has the required string fields
  const overrides: FormatterOverride[] = [];
  for (const item of obj.overrides) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (
      typeof o.id === "string" &&
      typeof o.extensions === "string" &&
      typeof o.command === "string" &&
      typeof o.args === "string"
    ) {
      overrides.push({ id: o.id, extensions: o.extensions, command: o.command, args: o.args });
    }
  }
  return {
    enabled: obj.enabled,
    formatOnAutoSave: obj.formatOnAutoSave === true,
    autoDetect: obj.autoDetect,
    overrides,
  };
}

// ---------------------------------------------------------------------------
// Log param parser
// ---------------------------------------------------------------------------

function parseLogParams(url: URL) {
  const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
  const all = url.searchParams.get("all") === "true";
  const branchesParam = url.searchParams.get("branches");
  const branches = branchesParam ? branchesParam.split(",") : [];
  const since = url.searchParams.get("since") ?? undefined;
  return { limit, all, branches, since };
}

// ---------------------------------------------------------------------------
// Project-scoped routes (derive project from ?project= or ?wt= params)
// ---------------------------------------------------------------------------

// GET /api/log
async function handleLog(req: Request, ctx: RouteContext): Promise<Response> {
  const resolved = resolveProjectFromReq(req, ctx);
  if (resolved instanceof Response) return resolved;
  const url = new URL(req.url);
  const { limit, all, branches, since } = parseLogParams(url);
  const commits = await git.getLog(resolved.cwd, { limit, all, branches, since });
  return json(commits);
}

// GET /api/graph — composite endpoint returning commits + refs in one response
async function handleGraph(req: Request, ctx: RouteContext): Promise<Response> {
  const resolved = resolveProjectFromReq(req, ctx);
  if (resolved instanceof Response) return resolved;
  const url = new URL(req.url);
  const { limit, all, branches, since } = parseLogParams(url);
  const [commits, refs] = await Promise.all([
    git.getLog(resolved.cwd, { limit, all, branches, since }),
    git.getRefs(resolved.cwd),
  ]);
  return json({ commits, refs });
}

// GET /api/branch-commits — commits for the current branch from merge-base to HEAD
async function handleBranchCommits(req: Request, ctx: RouteContext): Promise<Response> {
  const resolved = resolveWorktreeFromReq(req, ctx);
  if (resolved instanceof Response) return resolved;
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
  const data = await git.getBranchCommits(resolved.wtPath, { limit });
  return json(data);
}

// GET /api/status
async function handleStatus(req: Request, ctx: RouteContext): Promise<Response> {
  const resolved = resolveWorktreeFromReq(req, ctx);
  if (resolved instanceof Response) return resolved;
  const status = await git.getStatus(resolved.wtPath);
  return json(status);
}

// GET /api/diff
async function handleDiff(req: Request, ctx: RouteContext): Promise<Response> {
  const url = new URL(req.url);
  const staged = url.searchParams.get("staged") === "true";
  const commit = url.searchParams.get("commit");
  const range = url.searchParams.get("range");
  const worktree = url.searchParams.get("worktree");
  const base = url.searchParams.get("base") ?? undefined;

  // For worktree/commit/range diffs we need the project cwd
  const resolved = resolveProjectFromReq(req, ctx);
  if (resolved instanceof Response) return resolved;

  let diff: DiffInfo;
  if (worktree) {
    // Working tree diff: uncommitted changes
    diff = await git.getWorkingTreeDiff(resolved.cwd, worktree, base);
  } else if (commit) {
    diff = await git.getCommitDiff(resolved.cwd, commit);
  } else if (range) {
    diff = await git.getRangeDiff(resolved.cwd, range);
  } else if (staged) {
    // Staged diff needs worktree path
    const wtResolved = resolveWorktreeFromReq(req, ctx);
    if (wtResolved instanceof Response) return wtResolved;
    diff = await git.getStagedDiff(wtResolved.wtPath);
  } else {
    // Unstaged diff needs worktree path
    const wtResolved = resolveWorktreeFromReq(req, ctx);
    if (wtResolved instanceof Response) return wtResolved;
    diff = await git.getUnstagedDiff(wtResolved.wtPath);
  }

  return json(diff);
}

// GET /api/worktree-statuses
async function handleWorktreeStatuses(req: Request, ctx: RouteContext): Promise<Response> {
  const resolved = resolveProjectFromReq(req, ctx);
  if (resolved instanceof Response) return resolved;
  const statuses = await git.getDirtyWorktreeStatuses(resolved.cwd);
  return json(statuses);
}

// GET /api/branches
async function handleBranches(req: Request, ctx: RouteContext): Promise<Response> {
  const resolved = resolveProjectFromReq(req, ctx);
  if (resolved instanceof Response) return resolved;
  const branches = await git.getBranches(resolved.cwd);
  return json(branches);
}

// GET /api/branches/recent - Get branch names with recent activity
async function handleRecentBranches(req: Request, ctx: RouteContext): Promise<Response> {
  const resolved = resolveProjectFromReq(req, ctx);
  if (resolved instanceof Response) return resolved;
  const url = new URL(req.url);
  const days = parseInt(url.searchParams.get("days") ?? "7", 10);
  if (isNaN(days) || days < 1 || days > 365) {
    return error("Invalid days parameter (must be 1-365)");
  }
  const branches = await git.getRecentBranchNames(resolved.cwd, days);
  return json(branches);
}

// GET /api/refs
async function handleRefs(req: Request, ctx: RouteContext): Promise<Response> {
  const resolved = resolveProjectFromReq(req, ctx);
  if (resolved instanceof Response) return resolved;
  const refs = await git.getRefs(resolved.cwd);
  return json(refs);
}

// GET /api/file-lines - Get specific lines from a file at a ref
async function handleFileLines(req: Request, ctx: RouteContext): Promise<Response> {
  const resolved = resolveProjectFromReq(req, ctx);
  if (resolved instanceof Response) return resolved;
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const startLine = parseInt(url.searchParams.get("startLine") ?? "1", 10);
  const endLine = parseInt(url.searchParams.get("endLine") ?? "1", 10);
  const ref = url.searchParams.get("ref") ?? undefined;

  if (!path) {
    return error("Missing path parameter");
  }

  if (isNaN(startLine) || isNaN(endLine) || startLine < 1 || endLine < startLine) {
    return error("Invalid line range");
  }

  const lines = await git.getFileLines(resolved.cwd, path, startLine, endLine, ref);
  return json({ lines });
}

// GET /api/file-content - Get full file content at a ref or from worktree disk
async function handleFileContent(req: Request, ctx: RouteContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const ref = url.searchParams.get("ref") ?? undefined;
  const worktree = url.searchParams.get("worktree") ?? undefined;

  if (!path) {
    return error("Missing path parameter");
  }

  // Absolute path mode: resolve via ctx.resolveFilePath
  if (path.startsWith("/")) {
    const resolved = resolveFilePathWithHint(ctx, path, url.searchParams.get("wt"));
    if (!resolved) return error("File not found in any active worktree", 404);
    if (resolved.type === "detached") {
      const content = await resolved.resources.detachedFilesService.readFileContent(resolved.name);
      return json({ content });
    }
    if (resolved.type === "external") {
      try {
        const content = await resolved.resources.externalFilesService.readFileContent(
          resolved.absolutePath,
        );
        return json({ content });
      } catch {
        return error("File not found", 404);
      }
    }
    try {
      const content = await Bun.file(join(resolved.wtPath, resolved.relativePath)).text();
      return json({ content });
    } catch {
      return error("File not found", 404);
    }
  }

  // Relative path mode (legacy): use wt/ref params, returns { lines }
  // Accept ?worktree= as fallback for project resolution when ?wt= and ?project= are absent
  if (!url.searchParams.has("wt") && !url.searchParams.has("project") && worktree) {
    url.searchParams.set("wt", worktree);
  }
  const resolved = resolveProjectFromReq(new Request(url), ctx);
  if (resolved instanceof Response) return resolved;

  // If worktree is specified and no ref, read from disk
  if (worktree && !ref) {
    const lines = await git.getWorkingTreeFileContent(resolved.cwd, worktree, path);
    return json({ lines });
  }

  const lines = await git.getFileContent(resolved.cwd, path, ref);
  return json({ lines });
}

// GET /api/file-raw - Serve raw binary file content with correct Content-Type
async function handleFileRaw(req: Request, ctx: RouteContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");

  if (!path) return error("Missing path parameter", 400);

  let fullPath: string;

  if (path.startsWith("/")) {
    // Absolute path mode: resolve via ctx.resolveFilePath to validate ownership
    const resolved = resolveFilePathWithHint(ctx, path, url.searchParams.get("wt"));
    if (!resolved) return error("File not found in any active worktree", 404);
    fullPath = path;
  } else {
    // Relative path mode: requires wt parameter
    const worktree = url.searchParams.get("wt") ?? undefined;
    if (!worktree) return error("Missing wt parameter", 400);

    const resolved = resolveWorktreeFromReq(req, ctx);
    if (resolved instanceof Response) return resolved;

    git.validatePath(path);
    await git.validateWorktreePath(worktree, resolved.cwd);
    fullPath = join(worktree, path);
  }

  const file = Bun.file(fullPath);
  if (!(await file.exists())) return error("File not found", 404);

  const fileSize = file.size;
  const rangeHeader = req.headers.get("Range");

  // Support Range requests for video seeking
  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      const start = parseInt(match[1]!, 10);
      const end = match[2] ? parseInt(match[2]!, 10) : fileSize - 1;
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Content-Type": file.type,
        },
      });
    }
  }

  return new Response(file, { headers: { "Accept-Ranges": "bytes" } });
}

// GET /api/media-frame - Serve HTML wrapper page for media content in a sandboxed iframe
async function handleMediaFrame(req: Request, ctx: RouteContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");

  if (!path) return error("Missing path parameter", 400);

  let fullPath: string;
  let rawUrl: string;

  if (path.startsWith("/")) {
    // Absolute path mode: resolve via ctx.resolveFilePath to validate ownership
    const resolved = resolveFilePathWithHint(ctx, path, url.searchParams.get("wt"));
    if (!resolved) return error("File not found in any active worktree", 404);
    fullPath = path;
    const wtParam = url.searchParams.get("wt");
    rawUrl = `/api/file-raw?path=${encodeURIComponent(path)}${wtParam ? `&wt=${encodeURIComponent(wtParam)}` : ""}`;
  } else {
    // Relative path mode: requires wt parameter
    const worktree = url.searchParams.get("wt") ?? undefined;
    if (!worktree) return error("Missing wt parameter", 400);

    const resolved = resolveWorktreeFromReq(req, ctx);
    if (resolved instanceof Response) return resolved;

    git.validatePath(path);
    await git.validateWorktreePath(worktree, resolved.cwd);
    fullPath = join(worktree, path);
    rawUrl = `/api/file-raw?path=${encodeURIComponent(path)}&wt=${encodeURIComponent(worktree)}`;
  }

  const mediaType = getMediaType(path);
  if (!mediaType) return error("Unsupported media type", 400);
  let bodyContent: string;
  if (mediaType === "svg") {
    // SVGs are inlined so scripts can run (for WAAPI/JS-driven animations).
    // Security is enforced by CSP: the SVG CSP has NO server origin and
    // NO https:, so scripts cannot reach the loxel API or external servers.
    // Only data:/blob: resources are allowed (for embedded images/fonts).
    const file = Bun.file(fullPath);
    if (!(await file.exists())) return error("File not found", 404);
    const svgContent = await file.text();
    bodyContent = `${svgContent}
    <script>
      var el = document.querySelector("svg");
      if (el) {
        var vb = el.getAttribute("viewBox");
        if (vb) {
          var parts = vb.split(/[\\s,]+/).map(Number);
          postDimensions(parts[2] || el.clientWidth, parts[3] || el.clientHeight);
        } else {
          postDimensions(
            parseFloat(el.getAttribute("width")) || el.clientWidth || 300,
            parseFloat(el.getAttribute("height")) || el.clientHeight || 150
          );
        }
      }
    </script>`;
  } else if (mediaType === "video") {
    bodyContent = `<video id="v" src="${rawUrl}" onloadedmetadata="postDimensions(this.videoWidth, this.videoHeight)"></video>
    <script>
      var v = document.getElementById("v");
      function postState() {
        window.parent.postMessage({
          type: "media-video-state",
          playing: !v.paused,
          currentTime: v.currentTime,
          duration: v.duration || 0,
          volume: v.volume,
          muted: v.muted,
          playbackRate: v.playbackRate,
          loop: v.loop,
        }, "*");
      }
      v.addEventListener("play", postState);
      v.addEventListener("pause", postState);
      v.addEventListener("timeupdate", postState);
      v.addEventListener("durationchange", postState);
      v.addEventListener("volumechange", postState);
      v.addEventListener("ratechange", postState);
      v.addEventListener("seeked", postState);
      v.addEventListener("ended", postState);
      window.addEventListener("message", function(e) {
        if (!e.data || e.data.type !== "media-command") return;
        switch (e.data.command) {
          case "toggle": v.paused ? v.play() : v.pause(); break;
          case "seek": v.currentTime = e.data.value; break;
          case "volume": v.volume = e.data.value; break;
          case "mute": v.muted = !v.muted; break;
          case "speed": v.playbackRate = e.data.value; break;
          case "step": v.pause(); v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + e.data.value)); break;
          case "loop": v.loop = !v.loop; postState(); break;
        }
      });
    </script>`;
  } else {
    bodyContent = `<img src="${rawUrl}" onload="postDimensions(this.naturalWidth, this.naturalHeight)">`;
  }

  const html = `<!DOCTYPE html>
<html><head>
<script>
  function postDimensions(w, h) {
    window.parent.postMessage({ type: "media-dimensions", width: w, height: h }, "*");
  }
  // Forward wheel events to parent for zoom/pan — wheel events inside the iframe
  // don't cross the browsing context boundary, so the parent can't capture them.
  document.addEventListener("wheel", function(e) {
    e.preventDefault();
    window.parent.postMessage({
      type: "media-wheel",
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      clientX: e.clientX,
      clientY: e.clientY,
    }, "*");
  }, { passive: false });
</script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }
  body { display: flex; align-items: center; justify-content: center; }
  img, video, svg { display: block; max-width: 100%; max-height: 100%; }
</style>
</head>
<body>${bodyContent}</body></html>`;

  // CSP varies by media type:
  // - SVGs: inlined content may contain scripts (for animations). CSP blocks
  //   ALL network access (no server origin, no https:) so scripts can't reach
  //   the loxel API or exfiltrate data. Only data:/blob: for embedded resources.
  // - Images/Videos: loaded from /api/file-raw, so CSP needs the server origin.
  //   No untrusted scripts run — only our trusted inline code (postMessage, controls).
  //   The server origin is safe here because there's no user-controlled script.
  const baseCsp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ];

  let csp: string;
  if (mediaType === "svg") {
    csp = [...baseCsp, "img-src data: blob:", "font-src data:"].join("; ");
  } else {
    const serverOrigin = new URL(req.url).origin;
    csp = [
      ...baseCsp,
      `img-src ${serverOrigin} data: blob:`,
      `media-src ${serverOrigin} data: blob:`,
      "font-src data:",
    ].join("; ");
  }

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp },
  });
}

// GET /api/diagnostics
async function handleDiagnostics(req: Request, ctx: RouteContext): Promise<Response> {
  const resolved = resolveWorktreeFromReq(req, ctx);
  if (resolved instanceof Response) return resolved;
  const url = new URL(req.url);
  const ref = url.searchParams.get("ref") ?? undefined;
  const worktree = url.searchParams.get("worktree") ?? undefined;

  try {
    let targetDir = resolved.wtPath;
    if (worktree && !ref) {
      await git.validateWorktreePath(worktree, resolved.cwd);
      targetDir = worktree;
    }
    const diagnostics = await getDiagnostics(targetDir, ref);
    return json({ diagnostics });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Diagnostics failed";
    return json({ diagnostics: [], error: message });
  }
}

// ---------------------------------------------------------------------------
// Worktree-scoped POST routes (extract worktreePath from body)
// ---------------------------------------------------------------------------

// POST /api/stage
async function handleStage(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveProjectFromBody(body, ctx);
  if (resolved instanceof Response) return resolved;
  const files = requireStringArray(body, "files");
  await git.stageFiles(resolved.wtPath, files);
  return json({ success: true });
}

// POST /api/unstage
async function handleUnstage(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveProjectFromBody(body, ctx);
  if (resolved instanceof Response) return resolved;
  const files = requireStringArray(body, "files");
  await git.unstageFiles(resolved.wtPath, files);
  return json({ success: true });
}

// POST /api/commit
async function handleCommit(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveProjectFromBody(body, ctx);
  if (resolved instanceof Response) return resolved;
  const message = requireString(body, "message");
  const commit = await git.createCommit(resolved.wtPath, message);
  return json({ commit });
}

// POST /api/checkout
async function handleCheckout(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveProjectFromBody(body, ctx);
  if (resolved instanceof Response) return resolved;
  const ref = requireString(body, "ref");
  await git.checkout(resolved.wtPath, ref);
  return json({ success: true });
}

// POST /api/reset
async function handleReset(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveProjectFromBody(body, ctx);
  if (resolved instanceof Response) return resolved;
  const commit = requireString(body, "commit");
  const mode = requireString(body, "mode");
  if (mode !== "soft" && mode !== "mixed" && mode !== "hard") {
    throw new Error("mode must be soft, mixed, or hard");
  }
  await git.reset(resolved.wtPath, commit, mode);
  return json({ success: true });
}

// POST /api/cherry-pick
async function handleCherryPick(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveProjectFromBody(body, ctx);
  if (resolved instanceof Response) return resolved;
  const commits = requireStringArray(body, "commits");
  await git.cherryPick(resolved.cwd, commits);
  return json({ success: true });
}

// POST /api/revert
async function handleRevert(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveProjectFromBody(body, ctx);
  if (resolved instanceof Response) return resolved;
  const commits = requireStringArray(body, "commits");
  await git.revert(resolved.cwd, commits);
  return json({ success: true });
}

// POST /api/branch/create
async function handleBranchCreate(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveProjectFromBody(body, ctx);
  if (resolved instanceof Response) return resolved;
  const name = requireString(body, "name");
  const startPoint = typeof body.startPoint === "string" ? body.startPoint : undefined;
  await git.createBranch(resolved.cwd, name, startPoint);
  return json({ success: true });
}

// POST /api/branch/delete
async function handleBranchDelete(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveProjectFromBody(body, ctx);
  if (resolved instanceof Response) return resolved;
  const name = requireString(body, "name");
  const force = typeof body.force === "boolean" ? body.force : undefined;
  await git.deleteBranch(resolved.cwd, name, force);
  return json({ success: true });
}

// POST /api/branch/rename
async function handleBranchRename(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveProjectFromBody(body, ctx);
  if (resolved instanceof Response) return resolved;
  const oldName = requireString(body, "oldName");
  const newName = requireString(body, "newName");
  await git.renameBranch(resolved.cwd, oldName, newName);
  return json({ success: true });
}

// POST /api/discard
async function handleDiscard(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveProjectFromBody(body, ctx);
  if (resolved instanceof Response) return resolved;
  const files = requireStringArray(body, "files");
  await git.discardChanges(resolved.wtPath, files);
  return json({ success: true });
}

// POST /api/stage-hunk
async function handleStageHunk(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveProjectFromBody(body, ctx);
  if (resolved instanceof Response) return resolved;
  const patch = requireString(body, "patch");
  await git.stageHunk(resolved.wtPath, patch);
  return json({ success: true });
}

// POST /api/unstage-hunk
async function handleUnstageHunk(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveProjectFromBody(body, ctx);
  if (resolved instanceof Response) return resolved;
  const patch = requireString(body, "patch");
  await git.unstageHunk(resolved.wtPath, patch);
  return json({ success: true });
}

// POST /api/file-write — Write file content to disk with nonce for loop prevention
async function handleFileWrite(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const filePath = requireString(body, "path");
  let content = requireString(body, "content");
  const nonce = requireString(body, "nonce");
  const shouldFormat = body.format === true;
  const formattingSettings = shouldFormat
    ? parseFormattingSettings(body.formattingSettings)
    : undefined;

  async function maybeFormat(c: string, fp: string, wtPath: string): Promise<string> {
    if (!shouldFormat || !formattingSettings) return c;
    return (await ctx.formatContent(c, fp, wtPath, formattingSettings)) ?? c;
  }

  // Absolute path mode: resolve via ctx.resolveFilePath
  if (filePath.startsWith("/")) {
    const resolved = resolveFilePathWithHint(
      ctx,
      filePath,
      typeof body.worktreePath === "string" ? body.worktreePath : undefined,
      false,
    );
    if (!resolved) return error("File not found in any active worktree", 404);
    if (resolved.type === "detached") {
      await resolved.resources.detachedFilesService.writeFileContent(resolved.name, content, nonce);
      return json({ success: true });
    }
    if (resolved.type === "external") {
      await resolved.resources.externalFilesService.writeFileContent(
        resolved.absolutePath,
        content,
        nonce,
      );
      return json({ success: true });
    }
    // Format project files before writing (detached/external files skip formatting)
    content = await maybeFormat(content, filePath, resolved.wtPath);
    await resolved.resources.filesService.writeFile(resolved.relativePath, nonce, async () => {
      await Bun.write(join(resolved.wtPath, resolved.relativePath), content);
    });
    return json({ success: true, content });
  }

  // Relative path mode (legacy): use worktreePath from body
  const resolved = resolveProjectFromBody(body, ctx);
  if (resolved instanceof Response) return resolved;

  content = await maybeFormat(content, filePath, resolved.wtPath);

  const resources = ctx.getWorktreeResources(resolved.wtPath);
  if (resources) {
    await resources.filesService.writeFile(filePath, nonce, () =>
      git.writeWorkingTreeFileContent(resolved.cwd, resolved.wtPath, filePath, content),
    );
  } else {
    // Fallback for when no subscriber has activated resources yet
    await git.writeWorkingTreeFileContent(resolved.cwd, resolved.wtPath, filePath, content);
  }
  return json({ success: true, content });
}

// GET /api/detected-formatters?wt= — Return auto-detected formatters for a worktree
function handleDetectedFormatters(req: Request, ctx: RouteContext): Response {
  const url = new URL(req.url);
  const wtPath = url.searchParams.get("wt");
  if (!wtPath) return error("Missing wt parameter", 400);
  const formatters = ctx.getDetectedFormatters(wtPath);
  return json({ formatters });
}

// ---------------------------------------------------------------------------
// Service-dependent routes: files panel
// ---------------------------------------------------------------------------

// GET /api/files?wt=&dir= — list directory contents for the project files panel
async function handleFiles(req: Request, ctx: RouteContext): Promise<Response> {
  const url = new URL(req.url);
  const rawDir = url.searchParams.get("dir") ?? "";

  // Resolve worktree and relative dir from absolute or relative input
  let wt: string;
  let relDir: string;
  if (rawDir.startsWith("/")) {
    // Absolute dir: check if it's a worktree root or a subdir of one
    const resources = ctx.getWorktreeResources(rawDir);
    if (resources) {
      wt = rawDir;
      relDir = "";
    } else {
      const resolved = ctx.resolveFilePath(rawDir);
      if (!resolved || resolved.type !== "project") {
        return error("Directory not in any active worktree", 404);
      }
      wt = resolved.wtPath;
      relDir = resolved.relativePath;
    }
  } else {
    const wtParam = url.searchParams.get("wt");
    if (!wtParam) return error("Missing wt parameter", 400);
    wt = wtParam;
    relDir = rawDir;
  }

  const resources = ctx.getWorktreeResources(wt);
  if (!resources) return json([]);

  // Validate relative dir to prevent path traversal
  if (relDir) {
    try {
      git.validatePath(relDir);
    } catch {
      return error("Invalid directory path", 400);
    }
    const realWorktree = await realpath(wt).catch(() => wt);
    const real = await realpath(resolve(wt, relDir)).catch(() => null);
    if (!real || (!real.startsWith(realWorktree + "/") && real !== realWorktree)) {
      return error("Directory outside worktree", 400);
    }
  }

  try {
    const entries = await resources.filesService.getDirContents(relDir);
    return json(entries);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read directory";
    return error(message, 500);
  }
}

// POST /api/files/unwatch — clear cached directory contents for a collapsed directory
async function handleFilesUnwatch(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const rawDir = typeof body.dir === "string" ? body.dir : "";

  let wt: string;
  let relDir: string;
  if (rawDir.startsWith("/")) {
    const resources = ctx.getWorktreeResources(rawDir);
    if (resources) {
      wt = rawDir;
      relDir = "";
    } else {
      const resolved = ctx.resolveFilePath(rawDir);
      if (!resolved || resolved.type !== "project") return json({ ok: true });
      wt = resolved.wtPath;
      relDir = resolved.relativePath;
    }
  } else {
    const wtParam = typeof body.wt === "string" ? body.wt : undefined;
    if (!wtParam) return error("Missing wt in body", 400);
    wt = wtParam;
    relDir = rawDir;
  }

  const resources = ctx.getWorktreeResources(wt);
  if (!resources) return json({ ok: true });

  if (relDir) {
    try {
      git.validatePath(relDir);
    } catch {
      return error("Invalid directory path", 400);
    }
  }

  resources.filesService.unwatchDir(relDir);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Service-dependent routes: file operations (rename, delete, move, undo, redo)
// ---------------------------------------------------------------------------

/** Verify that a relative path resolves inside the worktree (prevents symlink escapes). */
async function assertContained(worktreeCwd: string, relPath: string): Promise<Response | null> {
  if (!relPath) return null;
  try {
    git.validatePath(relPath);
  } catch {
    return error("Invalid path", 400);
  }
  const realWorktree = await realpath(worktreeCwd).catch(() => worktreeCwd);
  const real = await realpath(resolve(worktreeCwd, relPath)).catch(() => null);
  if (!real || (!real.startsWith(realWorktree + "/") && real !== realWorktree)) {
    return error("Path outside worktree", 400);
  }
  return null;
}

function resolveFileOps(
  body: Record<string, unknown>,
  ctx: RouteContext,
): { resources: WorktreeResources; wt: string } | Response {
  const wt = typeof body.wt === "string" ? body.wt : undefined;
  if (!wt) return error("Missing wt in body", 400);
  const resources = ctx.getWorktreeResources(wt);
  if (!resources) return error("Worktree not active", 503);
  return { resources, wt };
}

/** Convert an absolute path to relative if it starts with the worktree prefix. */
function toRelativePath(rawPath: string, worktreeCwd: string): string {
  return rawPath.startsWith("/") ? relative(worktreeCwd, rawPath) : rawPath;
}

/** Normalize an absolute-or-relative worktree path to a safe relative path. */
function normalizeWorktreeRelativePath(rawPath: string, worktreeCwd: string): string | Response {
  if (!rawPath) return "";
  const relPath = toRelativePath(rawPath, worktreeCwd);
  if (relPath === "") return "";
  if (relPath === ".." || relPath.startsWith("../") || relPath.startsWith("/")) {
    return error("Path outside worktree", 400);
  }
  try {
    git.validatePath(relPath);
  } catch {
    return error("Invalid path", 400);
  }
  return relPath;
}

/** Convert result paths back to absolute if the original input was absolute. */
function toAbsoluteResult<T extends { newPath?: string; path?: string }>(
  result: T,
  wasAbsolute: boolean,
  worktreeCwd: string,
): T {
  if (!wasAbsolute) return result;
  if (result.newPath !== undefined)
    return { ...result, newPath: join(worktreeCwd, result.newPath) };
  if (result.path !== undefined) return { ...result, path: join(worktreeCwd, result.path) };
  return result;
}

/** Extract relative paths affected by an undo/redo result for tree notification. */
function getAffectedPaths(result: FileOperationResult): string[] {
  switch (result.type) {
    case "rename":
    case "move":
      return [result.oldPath, result.newPath];
    case "delete":
    case "restore":
    case "create":
      return [result.path];
    default: {
      const _exhaustive: never = result;
      throw new Error(`Unknown file operation result type: ${String(_exhaustive)}`);
    }
  }
}

// POST /api/files/rename
async function handleFileRename(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveFileOps(body, ctx);
  if (resolved instanceof Response) return resolved;
  const rawPath = requireString(body, "path");
  const newName = requireString(body, "newName");
  const isAbsolute = rawPath.startsWith("/");
  const path = toRelativePath(rawPath, resolved.wt);
  const denied = await assertContained(resolved.wt, path);
  if (denied) return denied;
  try {
    const result = await resolved.resources.fileOpsService.rename(path, newName);
    await resolved.resources.filesService.notifyChanges([path, result.newPath]);
    return json(toAbsoluteResult(result, isAbsolute, resolved.wt));
  } catch (err) {
    return error(err instanceof Error ? err.message : "Rename failed", 400);
  }
}

// POST /api/files/delete
async function handleFileDelete(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveFileOps(body, ctx);
  if (resolved instanceof Response) return resolved;
  const rawPath = requireString(body, "path");
  const path = toRelativePath(rawPath, resolved.wt);
  const denied = await assertContained(resolved.wt, path);
  if (denied) return denied;
  try {
    await resolved.resources.fileOpsService.delete(path);
    await resolved.resources.filesService.notifyChanges([path]);
    return json({ success: true });
  } catch (err) {
    return error(err instanceof Error ? err.message : "Delete failed", 400);
  }
}

// POST /api/files/move
async function handleFileMove(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveFileOps(body, ctx);
  if (resolved instanceof Response) return resolved;
  const rawSrcPath = requireString(body, "srcPath");
  const rawDestDir = typeof body.destDir === "string" ? body.destDir : "";
  const isAbsolute = rawSrcPath.startsWith("/");
  const srcPath = toRelativePath(rawSrcPath, resolved.wt);
  const destDir = rawDestDir.startsWith("/") ? toRelativePath(rawDestDir, resolved.wt) : rawDestDir;
  const denied = await assertContained(resolved.wt, srcPath);
  if (denied) return denied;
  if (destDir) {
    const destDenied = await assertContained(resolved.wt, destDir);
    if (destDenied) return destDenied;
  }
  try {
    const result = await resolved.resources.fileOpsService.move(srcPath, destDir);
    await resolved.resources.filesService.notifyChanges([srcPath, result.newPath]);
    return json(toAbsoluteResult(result, isAbsolute, resolved.wt));
  } catch (err) {
    return error(err instanceof Error ? err.message : "Move failed", 400);
  }
}

// POST /api/files/undo
async function handleFileUndo(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveFileOps(body, ctx);
  if (resolved instanceof Response) return resolved;
  try {
    const result = await resolved.resources.fileOpsService.undo();
    if (result) await resolved.resources.filesService.notifyChanges(getAffectedPaths(result));
    return json({ result });
  } catch (err) {
    return error(err instanceof Error ? err.message : "Undo failed", 500);
  }
}

// POST /api/files/redo
async function handleFileRedo(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveFileOps(body, ctx);
  if (resolved instanceof Response) return resolved;
  try {
    const result = await resolved.resources.fileOpsService.redo();
    if (result) await resolved.resources.filesService.notifyChanges(getAffectedPaths(result));
    return json({ result });
  } catch (err) {
    return error(err instanceof Error ? err.message : "Redo failed", 500);
  }
}

// POST /api/files/create-file
async function handleFileCreateFile(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveFileOps(body, ctx);
  if (resolved instanceof Response) return resolved;
  const rawDir = typeof body.dir === "string" ? body.dir : "";
  const isAbsolute = rawDir.startsWith("/");
  const dir = toRelativePath(rawDir, resolved.wt);
  const name = typeof body.name === "string" ? body.name : "Untitled.md";
  if (dir) {
    const denied = await assertContained(resolved.wt, dir);
    if (denied) return denied;
  }
  try {
    const result = await resolved.resources.fileOpsService.createFile(dir, name);
    await resolved.resources.filesService.notifyChanges([result.path]);
    return json(toAbsoluteResult(result, isAbsolute, resolved.wt));
  } catch (err) {
    return error(err instanceof Error ? err.message : "Create file failed", 400);
  }
}

// POST /api/files/create-dir
async function handleFileCreateDir(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveFileOps(body, ctx);
  if (resolved instanceof Response) return resolved;
  const rawDir = typeof body.dir === "string" ? body.dir : "";
  const isAbsolute = rawDir.startsWith("/");
  const dir = toRelativePath(rawDir, resolved.wt);
  const name = typeof body.name === "string" ? body.name : "Untitled";
  if (dir) {
    const denied = await assertContained(resolved.wt, dir);
    if (denied) return denied;
  }
  try {
    const result = await resolved.resources.fileOpsService.createDir(dir, name);
    await resolved.resources.filesService.notifyChanges([result.path]);
    return json(toAbsoluteResult(result, isAbsolute, resolved.wt));
  } catch (err) {
    return error(err instanceof Error ? err.message : "Create directory failed", 400);
  }
}

// POST /api/files/copy
async function handleFileCopy(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const resolved = resolveFileOps(body, ctx);
  if (resolved instanceof Response) return resolved;
  const rawSrcPath = requireString(body, "srcPath");
  const rawDestDir = typeof body.destDir === "string" ? body.destDir : "";
  const isAbsolute = rawSrcPath.startsWith("/");
  const srcPath = toRelativePath(rawSrcPath, resolved.wt);
  const destDir = rawDestDir.startsWith("/") ? toRelativePath(rawDestDir, resolved.wt) : rawDestDir;
  const denied = await assertContained(resolved.wt, srcPath);
  if (denied) return denied;
  if (destDir) {
    const destDenied = await assertContained(resolved.wt, destDir);
    if (destDenied) return destDenied;
  }
  try {
    const result = await resolved.resources.fileOpsService.copy(srcPath, destDir);
    await resolved.resources.filesService.notifyChanges([result.newPath]);
    return json(toAbsoluteResult(result, isAbsolute, resolved.wt));
  } catch (err) {
    return error(err instanceof Error ? err.message : "Copy failed", 400);
  }
}

// ---------------------------------------------------------------------------
// Service-dependent routes: detached files
// ---------------------------------------------------------------------------

// GET /api/detached-files?wt=
function handleDetachedFiles(req: Request, ctx: RouteContext): Response {
  const url = new URL(req.url);
  const wt = url.searchParams.get("wt");
  if (!wt) return error("Missing wt parameter", 400);
  const resources = ctx.getWorktreeResources(wt);
  if (!resources) return json([]);
  return json(resources.detachedFilesService.listFiles());
}

// GET /api/external-files?wt= — list externally opened files for the project explorer
function handleExternalFiles(req: Request, ctx: RouteContext): Response {
  const url = new URL(req.url);
  const wt = url.searchParams.get("wt");
  if (!wt) return error("Missing wt parameter", 400);
  const resources = ctx.getWorktreeResources(wt);
  if (!resources) return json([]);
  return json(resources.externalFilesService.listFiles());
}

// GET /api/detached-file-content?wt=&name=
async function handleDetachedFileContent(req: Request, ctx: RouteContext): Promise<Response> {
  const url = new URL(req.url);
  const wt = url.searchParams.get("wt");
  if (!wt) return error("Missing wt parameter", 400);
  const resources = ctx.getWorktreeResources(wt);
  if (!resources) return error("Worktree not active", 503);
  const name = url.searchParams.get("name");
  if (!name) return error("Missing name parameter", 400);
  if (name.includes("/") || name.includes("..")) return error("Invalid file name", 400);
  try {
    const content = await resources.detachedFilesService.readFileContent(name);
    return json({ content });
  } catch {
    return error("File not found", 404);
  }
}

// POST /api/detached-file-create
async function handleDetachedFileCreate(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const wt = typeof body.wt === "string" ? body.wt : undefined;
  if (!wt) return error("Missing wt in body", 400);
  const resources = ctx.getWorktreeResources(wt);
  if (!resources) return error("Worktree not active", 503);
  const prefix = requireString(body, "prefix");
  const ext = typeof body.ext === "string" ? body.ext : undefined;
  if (prefix.includes("/") || prefix.includes("..")) return error("Invalid prefix", 400);
  if (ext && (ext.includes("/") || ext.includes(".."))) return error("Invalid extension", 400);
  const content = typeof body.content === "string" ? body.content : undefined;
  const name = await resources.detachedFilesService.createFile(prefix, ext, content);
  return json({ name, path: join(resources.detachedFilesService.dir, name) });
}

// POST /api/detached-file-move
async function handleDetachedFileMove(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const wt = typeof body.wt === "string" ? body.wt : undefined;
  if (!wt) return error("Missing wt in body", 400);
  const resources = ctx.getWorktreeResources(wt);
  if (!resources) return error("Worktree not active", 503);
  const rawName = typeof body.name === "string" ? body.name : undefined;
  const srcPath = typeof body.path === "string" ? body.path : undefined;
  const name = srcPath?.startsWith("/") ? basename(srcPath) : rawName;
  if (!name) return error("Missing name or path in body", 400);
  const rawDestPath = typeof body.destPath === "string" ? body.destPath : "";
  const destPath = normalizeWorktreeRelativePath(rawDestPath, wt);
  if (destPath instanceof Response) return destPath;
  if (name.includes("/") || name.includes("..")) return error("Invalid file name", 400);

  try {
    const newPath = await resources.detachedFilesService.moveToProject(name, destPath, wt);
    return json({ newPath });
  } catch (err) {
    return error(err instanceof Error ? err.message : "Move failed", 500);
  }
}

// POST /api/detached-file-delete
async function handleDetachedFileDelete(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const wt = typeof body.wt === "string" ? body.wt : undefined;
  if (!wt) return error("Missing wt in body", 400);
  const resources = ctx.getWorktreeResources(wt);
  if (!resources) return error("Worktree not active", 503);
  const rawName = typeof body.name === "string" ? body.name : undefined;
  const path = typeof body.path === "string" ? body.path : undefined;
  const name = path?.startsWith("/") ? basename(path) : rawName;
  if (!name) return error("Missing name or path in body", 400);
  if (name.includes("/") || name.includes("..")) return error("Invalid file name", 400);
  await resources.detachedFilesService.deleteFile(name);
  return json({ success: true });
}

// POST /api/detached-file-rename
async function handleDetachedFileRename(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const wt = typeof body.wt === "string" ? body.wt : undefined;
  if (!wt) return error("Missing wt in body", 400);
  const resources = ctx.getWorktreeResources(wt);
  if (!resources) return error("Worktree not active", 503);
  const rawOldName = typeof body.oldName === "string" ? body.oldName : undefined;
  const oldPath = typeof body.path === "string" ? body.path : undefined;
  const oldName = oldPath?.startsWith("/") ? basename(oldPath) : rawOldName;
  if (!oldName) return error("Missing oldName or path in body", 400);
  const newName = requireString(body, "newName");
  if (oldName.includes("/") || oldName.includes("..")) return error("Invalid old file name", 400);
  if (newName.includes("/") || newName.includes("..")) return error("Invalid new file name", 400);

  try {
    await resources.detachedFilesService.renameFile(oldName, newName);
    return json({ success: true, path: join(resources.detachedFilesService.dir, newName) });
  } catch (err) {
    return error(err instanceof Error ? err.message : "Rename failed", 500);
  }
}

// POST /api/detached-file-copy-to-project
async function handleDetachedFileCopyToProject(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const wt = typeof body.wt === "string" ? body.wt : undefined;
  if (!wt) return error("Missing wt in body", 400);
  const resources = ctx.getWorktreeResources(wt);
  if (!resources) return error("Worktree not active", 503);
  const rawName = typeof body.name === "string" ? body.name : undefined;
  const srcPath = typeof body.path === "string" ? body.path : undefined;
  const name = srcPath?.startsWith("/") ? basename(srcPath) : rawName;
  if (!name) return error("Missing name or path in body", 400);
  if (name.includes("/") || name.includes("..")) return error("Invalid file name", 400);
  const rawDestPath = typeof body.destPath === "string" ? body.destPath : "";
  const destPath = normalizeWorktreeRelativePath(rawDestPath, wt);
  if (destPath instanceof Response) return destPath;

  try {
    const newPath = await resources.detachedFilesService.copyToProject(name, destPath, wt);
    return json({ newPath });
  } catch (err) {
    return error(err instanceof Error ? err.message : "Copy failed", 500);
  }
}

// ---------------------------------------------------------------------------
// No-context routes (project list, browse, version, logs, wt config, update)
// ---------------------------------------------------------------------------

/** Fast heuristic: check for .git (regular repo) or HEAD+objects (bare repo). */
function looksLikeGitRepo(dirPath: string): boolean {
  if (existsSync(join(dirPath, ".git"))) return true;
  return existsSync(join(dirPath, "HEAD")) && existsSync(join(dirPath, "objects"));
}

// GET /api/browse?path=/some/dir — list child directories for the folder picker
function handleBrowse(req: Request, _ctx: RouteContext): Response {
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path") ?? homedir();
  const dirPath = resolve(rawPath.replace(/^~/, homedir()));

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const dirs: BrowseEntry[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const fullPath = join(dirPath, entry.name);
      dirs.push({ name: entry.name, path: fullPath, isGitRepo: looksLikeGitRepo(fullPath) });
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name));
    return json({ path: dirPath, dirs });
  } catch {
    return json({ path: dirPath, dirs: [] });
  }
}

// ---------------------------------------------------------------------------
// Add Project Wizard routes
// ---------------------------------------------------------------------------

function expandTilde(p: string): string {
  return resolve(p.replace(/^~/, homedir()));
}

function requireSetup(body: Record<string, unknown>): WorkspaceSetup {
  const setup = requireString(body, "setup");
  if (setup !== "single" && setup !== "multi") {
    throw new Error("setup must be 'single' or 'multi'");
  }
  return setup;
}

function parseStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function validateCloneUrl(url: string): void {
  if (url.startsWith("-")) {
    throw new Error("Invalid clone URL");
  }
}

async function createInitialCommit(bareRepoPath: string): Promise<void> {
  const result = Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "Initial commit"], {
    cwd: bareRepoPath,
    env: { ...process.env, GIT_DIR: bareRepoPath, GIT_WORK_TREE: bareRepoPath },
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create initial commit: ${result.stderr.toString()}`);
  }
}

// POST /api/projects/detect — detect what a path points to
async function handleDetectPath(req: Request, _ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const rawPath = requireString(body, "path");
  const dirPath = expandTilde(rawPath);

  try {
    const exists = existsSync(dirPath);
    if (!exists) {
      const result: DetectPathResult = { type: "path-not-found", path: dirPath, name: "" };
      return json(result);
    }

    const repoType = await detectRepoType(dirPath);

    if (repoType === "bare") {
      const hasWtConf = existsSync(join(dirPath, "wt.yaml"));
      const result: DetectPathResult = {
        type: "git-repo-bare",
        path: dirPath,
        name: basename(dirPath).replace(/\.git$/, ""),
        hasWtConfig: hasWtConf,
      };
      return json(result);
    }

    if (repoType === "regular" || repoType === "worktree") {
      const gitRoot = await git.getGitRoot(dirPath);
      let branch: string | undefined;
      let dirty = false;
      try {
        branch = await getCurrentBranch(gitRoot);
      } catch {
        // detached HEAD
      }
      try {
        dirty = await hasUncommittedChanges(gitRoot);
      } catch {
        // ignore
      }
      const result: DetectPathResult = {
        type: "git-repo-regular",
        path: gitRoot,
        name: basename(gitRoot),
        branch,
        hasUncommittedChanges: dirty,
      };
      return json(result);
    }

    // empty or non-git directory
    const result: DetectPathResult = {
      type: "non-repo-folder",
      path: dirPath,
      name: basename(dirPath),
    };
    return json(result);
  } catch {
    const result: DetectPathResult = { type: "invalid", path: dirPath, name: "" };
    return json(result);
  }
}

/** Detection rules for auto-suggesting workspace setup files and commands. */
const SUGGESTION_RULES: Array<{ file: string; copyFile?: string; commands?: string[] }> = [
  { file: "bun.lock", commands: ["bun i --frozen-lockfile"] },
  { file: "bun.lockb", commands: ["bun i --frozen-lockfile"] },
  { file: "pnpm-lock.yaml", commands: ["pnpm i --frozen-lockfile"] },
  { file: "package-lock.json", commands: ["npm ci"] },
  { file: "yarn.lock", commands: ["yarn install --frozen-lockfile"] },
  { file: ".env", copyFile: ".env" },
  { file: ".env.local", copyFile: ".env.local" },
  { file: ".envrc", copyFile: ".envrc", commands: ["direnv allow"] },
  { file: ".mise.toml", commands: ["mise trust", "mise i"] },
  { file: ".tool-versions", commands: ["mise trust", "mise i"] },
];

// GET /api/projects/scan-suggestions?path=... — auto-detect files and commands for workspace setup
function handleScanSuggestions(req: Request, _ctx: RouteContext): Response {
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path") ?? "";
  if (!rawPath) return json({ files: [], commands: [] });
  const dirPath = expandTilde(rawPath);

  if (!existsSync(dirPath)) return json({ files: [], commands: [] });

  const files: string[] = [];
  const commands: string[] = [];
  const seenCommands = new Set<string>();

  for (const rule of SUGGESTION_RULES) {
    if (existsSync(join(dirPath, rule.file))) {
      if (rule.copyFile && !files.includes(rule.copyFile)) {
        files.push(rule.copyFile);
      }
      for (const cmd of rule.commands ?? []) {
        if (!seenCommands.has(cmd)) {
          seenCommands.add(cmd);
          commands.push(cmd);
        }
      }
    }
  }

  const result: ScanSuggestionsResult = { files, commands };
  return json(result);
}

// POST /api/projects/create — create a brand new project
async function handleCreateProject(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const name = requireString(body, "name");
  const location = requireString(body, "location");
  const setup = requireSetup(body);
  const copyFiles = parseStringArray(body, "copyFiles");
  const setupCommands = parseStringArray(body, "setupCommands");

  if (name.includes("/") || name.includes("\\") || name === ".." || name === ".") {
    return error("Invalid project name", 400);
  }

  const projectDir = join(expandTilde(location), name);

  if (existsSync(projectDir)) {
    return error(`Directory already exists: ${projectDir}`, 400);
  }

  mkdirSync(projectDir, { recursive: true });

  if (setup === "single") {
    const result = Bun.spawnSync(["git", "init"], { cwd: projectDir });
    if (result.exitCode !== 0) return error("git init failed", 500);
  } else {
    await initBareRepo(projectDir, "main");
    await createInitialCommit(projectDir);
    await writeWtYaml(projectDir, { baseBranch: "main", worktreesDir: ".worktrees" });
    await ensureWorktreesDir(projectDir, ".worktrees");

    if (copyFiles.length > 0 || setupCommands.length > 0) {
      await writeWtHooksConfig(projectDir, copyFiles, setupCommands);
    }

    const wtPath = join(projectDir, ".worktrees", "main");
    const wtResult = Bun.spawnSync(["git", "-C", projectDir, "worktree", "add", wtPath, "main"]);
    if (wtResult.exitCode !== 0) {
      return error(`Failed to create initial worktree: ${wtResult.stderr.toString()}`, 500);
    }
  }

  const project = await projectStore.addProject(projectDir, name);
  try {
    await ctx.initializeProject(project.path);
  } catch (err) {
    await projectStore.removeProject(project.id);
    return error(err instanceof Error ? err.message : "Failed to initialize project", 500);
  }

  ctx.broadcastAll(worktreesChangedMessage(project.path));
  return json(project);
}

// POST /api/projects/clone — clone a remote repo
async function handleCloneProject(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const url = requireString(body, "url");
  const destination = requireString(body, "destination");
  const setup = requireSetup(body);
  const copyFiles = parseStringArray(body, "copyFiles");
  const setupCommands = parseStringArray(body, "setupCommands");

  validateCloneUrl(url);
  const destDir = expandTilde(destination);
  mkdirSync(destDir, { recursive: true });

  if (setup === "single") {
    const repoName = repoNameFromUrl(url);
    const clonedPath = join(destDir, repoName);
    const result = Bun.spawnSync(["git", "clone", "--", url, clonedPath]);
    if (result.exitCode !== 0) {
      return error(`git clone failed: ${result.stderr.toString()}`, 500);
    }

    const project = await projectStore.addProject(clonedPath);
    try {
      await ctx.initializeProject(project.path);
    } catch (err) {
      await projectStore.removeProject(project.id);
      return error(err instanceof Error ? err.message : "Failed to initialize", 500);
    }
    ctx.broadcastAll(worktreesChangedMessage(project.path));
    return json(project);
  }

  // Multi-workspace: clone as bare
  const repoName = repoNameFromUrl(url);
  const bareDir = join(destDir, `${repoName}.git`);

  const result = Bun.spawnSync(["git", "clone", "--bare", "--", url, bareDir]);
  if (result.exitCode !== 0) {
    return error(`git clone --bare failed: ${result.stderr.toString()}`, 500);
  }

  // Determine default branch from the bare clone
  let baseBranch = "main";
  try {
    const headRef = await Bun.file(join(bareDir, "HEAD")).text();
    const match = headRef.match(/ref: refs\/heads\/(.+)/);
    if (match?.[1]) baseBranch = match[1].trim();
  } catch {
    // default to main
  }

  await writeWtYaml(bareDir, { baseBranch, worktreesDir: ".worktrees" });
  await ensureWorktreesDir(bareDir, ".worktrees");

  if (copyFiles.length > 0 || setupCommands.length > 0) {
    await writeWtHooksConfig(bareDir, copyFiles, setupCommands);
  }

  await executeAdd(
    {
      name: baseBranch,
      branch: baseBranch,
      open: false,
      repoPath: bareDir,
      hookEnv: buildSpawnEnv(),
    },
    wtProgress,
  );

  const project = await projectStore.addProject(bareDir, repoName);
  try {
    await ctx.initializeProject(project.path);
  } catch (err) {
    await projectStore.removeProject(project.id);
    return error(err instanceof Error ? err.message : "Failed to initialize", 500);
  }
  ctx.broadcastAll(worktreesChangedMessage(project.path));
  return json(project);
}

// POST /api/projects/init — initialize git in an existing non-repo folder
async function handleInitProject(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const path = requireString(body, "path");
  const name = typeof body.name === "string" ? body.name : undefined;
  const setup = requireSetup(body);
  const copyFiles = parseStringArray(body, "copyFiles");
  const setupCommands = parseStringArray(body, "setupCommands");

  const dirPath = expandTilde(path);

  if (!existsSync(dirPath)) {
    return error("Path does not exist", 400);
  }

  if (setup === "single") {
    const result = Bun.spawnSync(["git", "init"], { cwd: dirPath });
    if (result.exitCode !== 0) return error("git init failed", 500);
  } else {
    // For non-empty directories: init as regular repo first, then convert to bare.
    // This preserves existing files in a worktree instead of scattering bare repo
    // files among them.
    const entries = readdirSync(dirPath);
    const hasFiles = entries.some((e) => !e.startsWith("."));

    if (hasFiles) {
      const initResult = Bun.spawnSync(["git", "init"], { cwd: dirPath });
      if (initResult.exitCode !== 0) return error("git init failed", 500);
      const addResult = Bun.spawnSync(["git", "add", "."], { cwd: dirPath });
      if (addResult.exitCode !== 0) return error("git add failed", 500);
      const commitResult = Bun.spawnSync(["git", "commit", "-m", "Initial commit"], {
        cwd: dirPath,
      });
      if (commitResult.exitCode !== 0) {
        return error(`git commit failed: ${commitResult.stderr.toString()}`, 500);
      }
      const worktreesDir = ".worktrees";
      await transformToBare(dirPath, "main", worktreesDir);
      await writeWtYaml(dirPath, { baseBranch: "main", worktreesDir });
    } else {
      await initBareRepo(dirPath, "main");
      await createInitialCommit(dirPath);
      await writeWtYaml(dirPath, { baseBranch: "main", worktreesDir: ".worktrees" });
      await ensureWorktreesDir(dirPath, ".worktrees");

      const wtPath = join(dirPath, ".worktrees", "main");
      const wtResult = Bun.spawnSync(["git", "-C", dirPath, "worktree", "add", wtPath, "main"]);
      if (wtResult.exitCode !== 0) {
        return error(`Failed to create initial worktree: ${wtResult.stderr.toString()}`, 500);
      }
    }

    if (copyFiles.length > 0 || setupCommands.length > 0) {
      await writeWtHooksConfig(dirPath, copyFiles, setupCommands);
    }
  }

  const project = await projectStore.addProject(dirPath, name);
  try {
    await ctx.initializeProject(project.path);
  } catch (err) {
    await projectStore.removeProject(project.id);
    return error(err instanceof Error ? err.message : "Failed to initialize", 500);
  }
  ctx.broadcastAll(worktreesChangedMessage(project.path));
  return json(project);
}

// POST /api/projects/convert — convert regular repo to bare+wt
async function handleConvertProject(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const path = requireString(body, "path");
  const copyFiles = parseStringArray(body, "copyFiles");
  const setupCommands = parseStringArray(body, "setupCommands");

  const dirPath = expandTilde(path);

  const repoType = await detectRepoType(dirPath);
  if (repoType !== "regular") {
    return error("Path is not a regular git repository", 400);
  }

  if (existsSync(join(dirPath, "wt.yaml"))) {
    return error("Repository already has a wt.yaml configuration", 400);
  }

  const dirty = await hasUncommittedChanges(dirPath);
  if (dirty) {
    return error("Repository has uncommitted changes. Commit or stash them first.", 400);
  }

  // Teardown any existing project state before conversion
  ctx.teardownProject(dirPath);

  let currentBranch: string;
  try {
    currentBranch = await getCurrentBranch(dirPath);
  } catch {
    currentBranch = "main";
  }

  const worktreesDir = ".worktrees";
  await transformToBare(dirPath, currentBranch, worktreesDir);
  await writeWtYaml(dirPath, { baseBranch: currentBranch, worktreesDir });

  if (copyFiles.length > 0 || setupCommands.length > 0) {
    await writeWtHooksConfig(dirPath, copyFiles, setupCommands);
  }

  // Re-add and re-initialize the project
  const project = await projectStore.addProject(dirPath);
  try {
    await ctx.initializeProject(project.path);
  } catch (err) {
    await projectStore.removeProject(project.id);
    return error(err instanceof Error ? err.message : "Failed to initialize", 500);
  }
  ctx.broadcastAll(worktreesChangedMessage(project.path));
  return json(project);
}

/** Write hooks config (copy files + setup commands) into an existing wt.yaml. */
async function writeWtHooksConfig(
  repoDir: string,
  copyFiles: string[],
  setupCommands: string[],
): Promise<void> {
  const configPath = join(repoDir, "wt.yaml");
  if (!existsSync(configPath)) return;

  let content = await Bun.file(configPath).text();

  const hooksLines: string[] = ["hooks:", "  add:"];
  if (copyFiles.length > 0) {
    hooksLines.push("    files:");
    for (const f of copyFiles) {
      hooksLines.push(`      - '${f.replaceAll("'", "''")}'`);
    }

    // Create copy_source directory and empty placeholder files
    const copySourceDir = join(repoDir, ".wt-local-res");
    mkdirSync(copySourceDir, { recursive: true });
    for (const f of copyFiles) {
      const filePath = join(copySourceDir, f);
      mkdirSync(join(filePath, ".."), { recursive: true });
      if (!existsSync(filePath)) {
        await Bun.write(filePath, "");
      }
    }
  }
  if (setupCommands.length > 0) {
    const sanitized = setupCommands.map((cmd) => cmd.replaceAll("\n", " ").trim()).filter(Boolean);
    if (sanitized.length > 0) {
      hooksLines.push("    run: |");
      for (const cmd of sanitized) {
        hooksLines.push(`      ${cmd}`);
      }
    }
  }

  // Append hooks config to the YAML
  content += "\n" + hooksLines.join("\n") + "\n";
  await Bun.write(configPath, content);
}

// GET /api/projects
async function handleGetProjects(_req: Request, ctx: RouteContext): Promise<Response> {
  const data = await projectStore.loadProjects();
  const enriched = await Promise.all(
    data.projects.map(async (p) => {
      const project = ctx.getProject(p.path);
      if (!project) {
        return {
          ...p,
          worktrees: [],
          hasWtConfig: false,
          wtCliAvailable: false,
          worktreesDir: null,
        };
      }
      const worktrees = project.isBare ? await listProjectWorktrees(project.cwd) : [];
      return {
        ...p,
        isBare: project.isBare,
        hasWtConfig: project.hasWtConfig,
        wtCliAvailable: project.wtCliAvailable,
        worktreesDir: project.worktreesDir,
        worktrees,
      };
    }),
  );
  return json({ projects: enriched });
}

// POST /api/projects — add a new project and initialize its server state
async function handleAddProject(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const path = requireString(body, "path");
  const name = typeof body.name === "string" ? body.name : undefined;

  const project = await projectStore.addProject(path, name);

  // Start the project's repo watcher immediately if not already initialized
  if (!ctx.getProject(project.path)) {
    try {
      await ctx.initializeProject(project.path);
    } catch (err) {
      // Rollback: remove from projects.json since init failed
      await projectStore.removeProject(project.id);
      const message = err instanceof Error ? err.message : "Failed to initialize project";
      return error(message, 500);
    }
  }

  // Project add is a list-level event: broadcast to all clients. A brand-new
  // project has no wtResources entries yet, so broadcastToProject would be a
  // no-op and the UI would not refresh.
  ctx.broadcastAll(worktreesChangedMessage(project.path));
  return json(project);
}

// Project routes that require :id path parameter
async function handleProjectByIdRequest(
  req: Request,
  ctx: RouteContext,
  id: string,
): Promise<Response> {
  if (req.method === "DELETE") {
    const data = await projectStore.loadProjects();
    const project = data.projects.find((p) => p.id === id);
    if (!project) return error("Project not found", 404);

    // Teardown project server state (watcher, ReviewDb)
    ctx.teardownProject(project.path);

    // Remove from persistence
    await projectStore.removeProject(id);

    // Project delete is a list-level event: broadcast to all clients.
    // teardownProject has already wiped wtResources for this project, so
    // broadcastToProject would reach zero subscribers.
    ctx.broadcastAll(worktreesChangedMessage(project.path));
    return json({ success: true });
  }

  if (req.method === "PATCH") {
    const body = await parseBody(req);
    const name = typeof body.name === "string" ? body.name : undefined;
    const updated = await projectStore.updateProject(id, { name });
    return json(updated);
  }

  return error("Method not allowed", 405);
}

// POST /api/projects/:id/delete — remove project from loxel AND delete from disk
async function handleDeleteProjectFromDisk(
  req: Request,
  ctx: RouteContext,
  id: string,
): Promise<Response> {
  if (req.method !== "POST") return error("Method not allowed", 405);

  const data = await projectStore.loadProjects();
  const project = data.projects.find((p) => p.id === id);
  if (!project) return error("Project not found", 404);

  ctx.teardownProject(project.path);

  if (existsSync(project.path)) {
    await rm(project.path, { recursive: true, force: true });
  }

  await projectStore.removeProject(id);
  ctx.broadcastAll(worktreesChangedMessage(project.path));
  return json({ success: true });
}

/** List worktrees for a bare project (wt-managed or plain git). */
async function listProjectWorktrees(projectPath: string): Promise<WorktreeEntryResponse[]> {
  const wtConfigPath = join(projectPath, "wt.yaml");
  if (existsSync(wtConfigPath)) {
    const managed = await listManagedWorktrees(projectPath);
    return Promise.all(
      managed.map(async (wt) => {
        const createdAt = await statCreatedAt(wt.path);
        return {
          path: wt.path,
          branch: wt.branch,
          commit: wt.head,
          isMain: false,
          createdAt,
          wtName: wt.name,
        };
      }),
    );
  }
  const allWorktrees = await git.getWorktrees(projectPath);
  return allWorktrees.filter((wt) => !basename(wt.path).startsWith(INTERNAL_WORKTREE_PREFIX));
}

// GET /api/projects/:id/worktrees
async function handleProjectWorktrees(projectPath: string, isBare: boolean): Promise<Response> {
  if (!isBare) return json({ worktrees: [] });
  const worktrees = await listProjectWorktrees(projectPath);
  return json({ worktrees });
}

/** Shape returned by GET /api/projects/:id/worktrees — WorktreeEntry with optional wtName. */
interface WorktreeEntryResponse {
  path: string;
  branch: string | null;
  commit: string;
  isMain: boolean;
  createdAt: string | null;
  wtName?: string;
}

async function statCreatedAt(dirPath: string): Promise<string | null> {
  try {
    const stats = await stat(dirPath);
    return stats.birthtime.toISOString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Worktree CRUD routes (project from body param)
// ---------------------------------------------------------------------------

// POST /api/worktree/plan-add
async function handlePlanAddWorktree(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const projectPath = requireString(body, "projectPath");
  const project = ctx.getProject(projectPath);
  if (!project) return error("Project not found", 404);
  if (!project.hasWtConfig) return error("No wt.yaml config found", 400);
  const name = requireString(body, "name");

  try {
    const plan: AddPlan = await planAdd({ name, repoPath: project.cwd });
    return json(plan);
  } catch (err) {
    return error(err instanceof Error ? err.message : "planAdd failed");
  }
}

// POST /api/worktree/create
async function handleCreateWorktree(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const projectPath = requireString(body, "projectPath");
  const project = ctx.getProject(projectPath);
  if (!project) return error("Project not found", 404);
  const name = requireString(body, "name");
  const branch = typeof body.branch === "string" ? body.branch : undefined;
  const branchResolution =
    body.branchResolution === "use-existing" || body.branchResolution === "delete-and-create"
      ? body.branchResolution
      : undefined;

  if (project.hasWtConfig) {
    // Use wt library directly
    wtLog.info(`Creating worktree '${name}'`, { branch, branchResolution });
    try {
      const result = await executeAdd(
        {
          name,
          branch,
          branchResolution,
          open: false,
          repoPath: project.cwd,
          hookEnv: buildSpawnEnv(),
        },
        wtProgress,
      );
      wtLog.info(`Worktree '${name}' created`, {
        path: result.path,
        portOffset: result.portOffset,
      });
      ctx.broadcastToProject(project.cwd, worktreesChangedMessage(project.cwd));
      return json(result);
    } catch (err) {
      wtLog.error(`Failed to create worktree '${name}'`, { error: err });
      return error(err instanceof Error ? err.message : "executeAdd failed");
    }
  } else {
    // Use plain git
    const worktreesDir = join(project.cwd, ".worktrees");
    const wtPath = join(worktreesDir, name);
    if (branch) {
      await Bun.$`git -C ${project.cwd} worktree add -b ${name} ${wtPath} ${branch}`;
    } else {
      await Bun.$`git -C ${project.cwd} worktree add -b ${name} ${wtPath}`;
    }
  }

  ctx.broadcastToProject(project.cwd, worktreesChangedMessage(project.cwd));
  return json({ success: true });
}

// POST /api/worktree/plan-remove
async function handlePlanRemoveWorktree(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const projectPath = requireString(body, "projectPath");
  const project = ctx.getProject(projectPath);
  if (!project) return error("Project not found", 404);
  if (!project.hasWtConfig || !project.worktreesDir) {
    return error("No wt.yaml config found", 400);
  }
  // Client sends the worktree path — extract the wt directory name relative to worktreesDir
  const wtPath = requireString(body, "path");
  const name = getWorktreeName(wtPath, project.worktreesDir);

  try {
    const plan: RemovePlan = await planRemove({ name, repoPath: project.cwd });
    return json(plan);
  } catch (err) {
    return error(err instanceof Error ? err.message : "planRemove failed");
  }
}

// POST /api/worktree/remove
async function handleRemoveWorktree(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const projectPath = requireString(body, "projectPath");
  const project = ctx.getProject(projectPath);
  if (!project) return error("Project not found", 404);

  if (project.hasWtConfig && project.worktreesDir) {
    // Use wt library directly — client sends the worktree path
    const wtPath = requireString(body, "path");
    const name = getWorktreeName(wtPath, project.worktreesDir);
    const deleteBranch = typeof body.deleteBranch === "boolean" ? body.deleteBranch : false;
    const force = typeof body.force === "boolean" ? body.force : false;

    wtLog.info(`Removing worktree '${name}'`, { deleteBranch, force });
    try {
      const result = await executeRemove(
        { name, deleteBranch, force, repoPath: project.cwd, hookEnv: buildSpawnEnv() },
        wtProgress,
      );
      wtLog.info(`Worktree '${name}' removed`, { branchDeleted: result.branchDeleted });
      ctx.broadcastToProject(project.cwd, worktreesChangedMessage(project.cwd));
      return json(result);
    } catch (err) {
      wtLog.error(`Failed to remove worktree '${name}'`, { error: err });
      return error(err instanceof Error ? err.message : "executeRemove failed");
    }
  } else {
    // Fallback: plain git — uses path-based API
    const wtPath = requireString(body, "path");
    const force = typeof body.force === "boolean" ? body.force : false;

    await git.validateWorktreePath(wtPath, project.cwd);

    const args = ["git", "-C", project.cwd, "worktree", "remove", wtPath];
    if (force) args.push("--force");
    const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      return error(`git worktree remove failed: ${stderr.trim()}`);
    }
  }

  ctx.broadcastToProject(project.cwd, worktreesChangedMessage(project.cwd));
  return json({ success: true });
}

// ---------------------------------------------------------------------------
// Server logs
// ---------------------------------------------------------------------------

// POST /api/log — ingest a frontend log entry into the server logger pipeline
async function handleLogIngest(req: Request): Promise<Response> {
  const body = (await req.json()) as Record<string, unknown>;
  const level = typeof body.level === "string" ? body.level : undefined;
  const cat = typeof body.cat === "string" ? body.cat : undefined;
  const msg = typeof body.msg === "string" ? body.msg : undefined;

  if (!level || !cat || !msg) return error("Missing required fields: level, cat, msg");
  if (!(level in LOG_LEVEL_PRIORITY)) return error(`Invalid level: ${level}`);
  if (!LOG_CATEGORIES.includes(cat as LogCategory)) return error(`Invalid category: ${cat}`);

  const ctx =
    typeof body.ctx === "object" && body.ctx !== null
      ? (body.ctx as Record<string, unknown>)
      : undefined;
  logger.ingest(level as LogLevel, cat as LogCategory, msg, ctx);
  return json({ ok: true });
}

// GET /api/logs — server log history from in-memory ring buffer
function handleLogs(req: Request, _ctx: RouteContext): Response {
  const url = new URL(req.url);
  const before = parseInt(url.searchParams.get("before") ?? "", 10) || undefined;
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10), 500);
  const { entries, hasMore } = logger.getHistory(before, limit);
  return json({ entries, hasMore });
}

// ---------------------------------------------------------------------------
// Schema resolution routes
// ---------------------------------------------------------------------------

/** Classify a glob as JSON-applicable, YAML-applicable, or both. */
function classifyGlob(glob: string): { json: boolean; yaml: boolean } {
  const extensions = new Set<string>();
  const braceMatch = /\.\{([^}]+)\}$/.exec(glob);
  if (braceMatch) {
    for (const ext of braceMatch[1]!.split(",")) extensions.add(ext.trim());
  } else {
    const simpleMatch = /\.(\w+)$/.exec(glob);
    if (simpleMatch) extensions.add(simpleMatch[1]!);
  }

  const isJson = extensions.has("json") || extensions.has("jsonc");
  const isYaml = extensions.has("yml") || extensions.has("yaml");
  // If neither matched (e.g. **/*), apply to both
  if (!isJson && !isYaml) return { json: true, yaml: true };
  return { json: isJson, yaml: isYaml };
}

// GET /api/schemas/resolve?url=<urlOrPath>&baseDir=<dir>
async function handleSchemaResolve(req: Request, ctx: RouteContext): Promise<Response> {
  const url = new URL(req.url);
  const schemaUrl = url.searchParams.get("url");
  if (!schemaUrl) return error("Missing url parameter");

  const baseDir = url.searchParams.get("baseDir") ?? undefined;
  const schema = await ctx.resolveSchema(schemaUrl, baseDir);
  if (schema === null) return error("Failed to resolve schema", 404);
  return json(schema);
}

// POST /api/schemas/sync — resolve configured schemas, update YAML LSP
async function handleSchemaSync(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);
  const schemas = body.schemas;
  if (!Array.isArray(schemas)) return error("schemas must be an array");

  const yamlMap: Record<string, string[]> = {};
  const wtSchemaUrl = `http://127.0.0.1:${config.port}/api/wt-json-schema`;

  // Collect JSON schemas to resolve and build YAML map in a single pass
  const jsonToResolve: { glob: string; resolvedUrl: string }[] = [];

  for (const entry of schemas) {
    if (typeof entry !== "object" || entry === null) continue;
    const { glob, url } = entry as { glob?: string; url?: string };
    if (typeof glob !== "string" || typeof url !== "string") continue;

    const resolvedUrl = url === "__builtin:wt-json-schema__" ? wtSchemaUrl : url;
    const classification = classifyGlob(glob);

    if (classification.json) {
      jsonToResolve.push({ glob, resolvedUrl });
    }

    if (classification.yaml) {
      // Convert local file paths to file:// URLs for yaml-language-server
      let yamlSchemaUrl = resolvedUrl;
      if (!resolvedUrl.startsWith("http://") && !resolvedUrl.startsWith("https://")) {
        yamlSchemaUrl = resolvedUrl.startsWith("/") ? `file://${resolvedUrl}` : resolvedUrl;
      }
      const existing = yamlMap[yamlSchemaUrl];
      if (existing) {
        existing.push(glob);
      } else {
        yamlMap[yamlSchemaUrl] = [glob];
      }
    }
  }

  // Resolve JSON schemas in parallel
  const jsonResults = await Promise.all(
    jsonToResolve.map(async ({ glob, resolvedUrl }) => {
      const schema = await ctx.resolveSchema(resolvedUrl);
      return { glob, url: resolvedUrl, schema };
    }),
  );

  ctx.updateYamlSchemas(yamlMap);
  return json({ json: jsonResults, yaml: { synced: true } });
}

// ---------------------------------------------------------------------------
// Wt config routes (project-level)
// ---------------------------------------------------------------------------

// GET /api/wt-json-schema — JSON schema for wt.yaml autocomplete
function handleWtJsonSchema(): Response {
  return json(WT_CONFIG_JSON_SCHEMA);
}

// GET /api/wt-config-raw?projectId=xxx — raw wt.yaml content for a project
async function handleWtConfigRaw(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return error("Missing projectId parameter");

  const data = await projectStore.loadProjects();
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) return error("Project not found", 404);

  const configPath = join(project.path, "wt.yaml");
  if (!existsSync(configPath)) return error("No wt.yaml found", 404);

  const content = await Bun.file(configPath).text();
  return json({ content });
}

// POST /api/wt-config-save — write wt.yaml content for a project
async function handleWtConfigSave(req: Request): Promise<Response> {
  const body = await parseBody(req);
  const projectId = requireString(body, "projectId");
  const content = requireString(body, "content");

  const data = await projectStore.loadProjects();
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) return error("Project not found", 404);

  const configPath = join(project.path, "wt.yaml");
  if (!existsSync(configPath)) return error("No wt.yaml found", 404);
  await Bun.write(configPath, content);
  return json({ success: true });
}

// ---------------------------------------------------------------------------
// Update routes
// ---------------------------------------------------------------------------

// GET /api/version
function handleGetVersion(): Response {
  return json({ version: getCurrentVersion(), isDev: config.isDev });
}

// GET /api/update/status
function handleGetUpdateStatus(): Response {
  return json(getUpdateStatus());
}

// POST /api/update/check
async function handleUpdateCheck(_req: Request, ctx: RouteContext): Promise<Response> {
  await checkForUpdate(ctx.broadcastAll);
  return json(getUpdateStatus());
}

// POST /api/update/download
async function handleUpdateDownload(_req: Request, ctx: RouteContext): Promise<Response> {
  await downloadUpdate(ctx.broadcastAll);
  return json(getUpdateStatus());
}

// POST /api/update/install
function handleUpdateInstall(_req: Request, ctx: RouteContext): Response {
  if (config.isDev) return error("Updates are not available in development mode");

  const status = getUpdateStatus();
  if (status.state !== "ready") return error("No update is ready to install");

  const resourcesDir = process.env.LOXEL_RESOURCES_DIR;
  if (!resourcesDir) return error("Cannot determine resources directory");

  // Check write access before committing to exit
  try {
    mkdirSync(resourcesDir, { recursive: true });
    accessSync(resourcesDir, constants.W_OK);
  } catch {
    return error("Resources directory is not writable");
  }

  if (!prepareInstall()) return error("Failed to prepare update");

  // Broadcast installing state before shutdown
  ctx.broadcastAll({ type: "update_status_changed", data: { state: "installing" } });

  // Schedule shutdown after response is sent
  setTimeout(() => ctx.shutdown(42), 100);

  return json({ success: true });
}

// ---------------------------------------------------------------------------
// Open file (CLI integration)
// ---------------------------------------------------------------------------

// POST /api/open — open a file or URL in the appropriate panel (triggered by `loxel` CLI)
async function handleOpen(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await parseBody(req);

  // URL mode: open in browser panel
  if (typeof body.url === "string") {
    if (!isHttpUrl(body.url)) {
      return error("Invalid URL — only http and https URLs are supported", 400);
    }

    const wtPath = typeof body.wtPath === "string" ? body.wtPath : null;
    if (!wtPath || !ctx.findProjectForPath(wtPath)) {
      return error("No project found for worktree", 404);
    }

    ctx.broadcastToSubscribers(wtPath, { type: "open_url", wtPath, data: { url: body.url } });
    return json({ ok: true });
  }

  // File mode: open in the appropriate editor panel
  const filePath = body.filePath;
  if (typeof filePath !== "string") return error("Missing filePath or url in body", 400);

  // Determine worktree path: explicit or derived from file path
  let wtPath: string;
  if (typeof body.wtPath === "string") {
    if (!ctx.findProjectForPath(body.wtPath)) return error("No project found for worktree", 404);
    wtPath = body.wtPath;
  } else {
    const project = ctx.findProjectForPath(filePath);
    if (!project) return error("No project found for file path", 404);
    wtPath = project.cwd;
  }

  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) return error("File not found", 404);

  // If file is outside the worktree, register it as an external file for watching
  const relPath = relative(wtPath, absolutePath);
  if (relPath.startsWith("../") || relPath === "..") {
    const resources = ctx.getWorktreeResources(wtPath);
    if (!resources) {
      return error("Worktree not active — no subscribers to receive the file", 503);
    }
    resources.externalFilesService.addFile(absolutePath);
  }

  ctx.broadcastToSubscribers(wtPath, {
    type: "open_file",
    wtPath,
    data: { filePath: absolutePath },
  });

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Full-text search via ripgrep
// ---------------------------------------------------------------------------

/** Convert a byte offset to a character offset in a UTF-8 string. */
function byteOffsetToCharOffset(text: string, byteOffset: number): number {
  const buf = Buffer.from(text, "utf-8");
  return Buffer.from(buf.buffer, buf.byteOffset, Math.min(byteOffset, buf.length)).toString("utf-8")
    .length;
}

type RgSubmatch = { match: { text: string }; start: number; end: number };
type RgMatchData = {
  path: { text: string };
  lines: { text: string };
  line_number: number;
  submatches: RgSubmatch[];
};
type RgMatchLine = { type: "match"; data: RgMatchData };

function isRgMatchLine(raw: unknown): raw is RgMatchLine {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  if (r.type !== "match") return false;
  const d = r.data as Record<string, unknown> | undefined;
  return !!(
    d?.path &&
    d?.lines &&
    typeof d?.line_number === "number" &&
    Array.isArray(d?.submatches)
  );
}

/** Parse rg --json stdout line-by-line, killing the process once maxResults is reached. */
async function collectSearchMatches(
  proc: ReturnType<typeof Bun.spawn>,
  maxResults: number,
  signal: AbortSignal,
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  const matches: SearchMatch[] = [];
  let truncated = false;
  let partial = "";

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  const onAbort = () => proc.kill();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      partial += decoder.decode(value, { stream: true });
      const lines = partial.split("\n");
      partial = lines.pop()!; // keep incomplete last line

      for (const line of lines) {
        if (!line) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch (e) {
          searchLog.warn("rg JSON parse error", { line, error: e });
          continue;
        }
        if (!isRgMatchLine(raw)) continue;
        const data = raw.data;
        const filePath = data.path.text;
        const lineText = data.lines.text.replace(/\n$/, "");
        const lineNumber = data.line_number;

        for (const sub of data.submatches) {
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
          const matchStart = byteOffsetToCharOffset(lineText, sub.start);
          const matchEnd = byteOffsetToCharOffset(lineText, sub.end);
          matches.push({
            filePath,
            line: lineNumber,
            column: matchStart + 1,
            lineText,
            matchStart,
            matchEnd,
          });
        }

        if (truncated) {
          proc.kill();
          return { matches, truncated };
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  return { matches, truncated };
}

// GET /api/search
async function handleSearch(req: Request, ctx: RouteContext): Promise<Response> {
  const resolved = resolveWorktreeFromReq(req, ctx);
  if (resolved instanceof Response) return resolved;

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  if (!q) return json({ matches: [], truncated: false });

  const useRegex = url.searchParams.get("regex") === "true";
  const caseSensitive = url.searchParams.get("caseSensitive") === "true";
  const wholeWord = url.searchParams.get("wholeWord") === "true";
  const maxResults = Math.min(parseInt(url.searchParams.get("maxResults") ?? "500", 10), 2000);
  const scope = url.searchParams.get("scope") ?? "all";
  const pathsParam = url.searchParams.get("paths") ?? "";
  const globsParam = url.searchParams.get("globs") ?? "";

  const args: string[] = [
    "rg",
    "--json",
    "--line-number",
    "--column",
    "--max-columns",
    "500",
    "--max-count",
    "50",
  ];

  if (scope === "ignored") args.push("--no-ignore");

  // Extension glob filters (e.g. --glob '*.ts' --glob '*.tsx')
  if (globsParam) {
    for (const g of globsParam.split(",")) {
      const trimmed = g.trim();
      if (trimmed) args.push("--glob", trimmed);
    }
  }

  if (!useRegex) args.push("--fixed-strings");
  if (wholeWord) args.push("--word-regexp");
  args.push(caseSensitive ? "--case-sensitive" : "--ignore-case");
  args.push("--", q);

  // Determine search paths based on scope and paths params
  const resources = ctx.getWorktreeResources(resolved.wtPath);
  const detachedDir = resources?.detachedFilesService.dir;

  if (pathsParam) {
    // Explicit paths — resolve each relative to worktree root and validate
    for (const rel of pathsParam.split(",")) {
      const trimmed = rel.trim();
      if (!trimmed) continue;
      const abs = resolve(resolved.wtPath, trimmed);
      if (!abs.startsWith(resolved.wtPath + "/") && abs !== resolved.wtPath) {
        return error(`Path escapes worktree: ${trimmed}`, 400);
      }
      if (existsSync(abs)) args.push(abs);
    }
    // For scope=all with explicit paths, also include drafts
    if (scope === "all" && detachedDir && existsSync(detachedDir)) {
      args.push(detachedDir);
    }
  } else if (scope === "drafts") {
    if (detachedDir && existsSync(detachedDir)) {
      args.push(detachedDir);
    } else {
      return json({ matches: [], truncated: false });
    }
  } else {
    // all, worktree, or ignored — search the worktree directory
    args.push(resolved.wtPath);
    if (scope === "all" && detachedDir && existsSync(detachedDir)) {
      args.push(detachedDir);
    }
  }

  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: buildSpawnEnv() });
    const result = await collectSearchMatches(proc, maxResults, req.signal);
    const exitCode = await proc.exited;

    // rg exits 1 for "no matches" and 2 for errors (e.g. invalid regex)
    if (exitCode === 2) {
      const stderr = await new Response(proc.stderr).text();
      return error(stderr.trim() || "Search failed (invalid pattern?)", 400);
    }

    return json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    if (message.includes("ENOENT") || message.includes("not found")) {
      return error("ripgrep (rg) is not installed", 500);
    }
    return error(message, 500);
  }
}

// GET /api/search-scopes
async function handleSearchScopes(req: Request, ctx: RouteContext): Promise<Response> {
  const resolved = resolveWorktreeFromReq(req, ctx);
  if (resolved instanceof Response) return resolved;

  const [packages, fileIndex] = await Promise.all([
    findWorkspacePackages(resolved.wtPath),
    collectWorktreeFileIndex(resolved.wtPath),
  ]);

  return json({
    packages: packages.map((p) => ({ name: p.name, relativePath: p.relativeDir })),
    dirs: fileIndex.dirs,
    extensions: fileIndex.extensions,
  });
}

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "webp",
  "avif",
  "svg",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "wav",
  "ogg",
  "webm",
  "flac",
  "aac",
  "zip",
  "gz",
  "tar",
  "bz2",
  "7z",
  "rar",
  "zst",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "exe",
  "dll",
  "so",
  "dylib",
  "o",
  "a",
  "lib",
  "wasm",
  "node",
  "pyc",
  "class",
  "sqlite",
  "db",
  "sqlite3",
  "pbxproj",
  "xcworkspacedata",
]);

/** Use ripgrep --files to collect all non-ignored dirs and file extensions in the worktree. */
async function collectWorktreeFileIndex(
  wtPath: string,
): Promise<{ dirs: string[]; extensions: string[] }> {
  const proc = Bun.spawn(
    ["rg", "--files", "--hidden", "--glob", "!.git/", "--sort", "path", wtPath],
    { stdout: "pipe", stderr: "pipe", env: buildSpawnEnv() },
  );
  const text = await new Response(proc.stdout).text();
  await proc.exited;

  const dirs = new Set<string>();
  const extCounts = new Map<string, number>();
  const prefix = wtPath + "/";

  for (const line of text.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const rel = line.slice(prefix.length);

    // Collect parent directories
    let idx = rel.indexOf("/");
    while (idx !== -1) {
      dirs.add(rel.slice(0, idx));
      idx = rel.indexOf("/", idx + 1);
    }

    // Collect extension
    const dotIdx = rel.lastIndexOf(".");
    if (dotIdx !== -1 && dotIdx < rel.length - 1) {
      const ext = rel.slice(dotIdx + 1);
      extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    }
  }

  const sortedDirs = [...dirs].sort();
  // Sort extensions by frequency (most common first), exclude binary formats
  const sortedExts = [...extCounts.entries()]
    .filter(([ext]) => !BINARY_EXTENSIONS.has(ext))
    .sort((a, b) => b[1] - a[1])
    .map(([ext]) => ext);

  return { dirs: sortedDirs, extensions: sortedExts };
}

const FILE_INDEX_MAX_FILES = 100_000;

/** Use ripgrep --files to collect all relative file paths in the worktree for quick-open search. */
async function collectFileList(wtPath: string): Promise<{ files: string[]; truncated: boolean }> {
  const proc = Bun.spawn(
    ["rg", "--files", "--hidden", "--glob", "!.git/", "--sort", "path", wtPath],
    { stdout: "pipe", stderr: "pipe", env: buildSpawnEnv() },
  );
  const text = await new Response(proc.stdout).text();
  await proc.exited;

  const files: string[] = [];
  let truncated = false;
  const prefix = wtPath + "/";

  for (const line of text.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    if (files.length < FILE_INDEX_MAX_FILES) {
      files.push(line.slice(prefix.length));
    } else {
      truncated = true;
    }
  }

  return { files, truncated };
}

// GET /api/file-index — list all file paths in the worktree for quick-open search
async function handleFileIndex(req: Request, ctx: RouteContext): Promise<Response> {
  const resolved = resolveWorktreeFromReq(req, ctx);
  if (resolved instanceof Response) return resolved;

  return json(await collectFileList(resolved.wtPath));
}

// ---------------------------------------------------------------------------
// Unified route table
// ---------------------------------------------------------------------------

const routes: Record<string, Record<string, RouteHandler>> = {
  GET: {
    "/api/projects": handleGetProjects,
    "/api/browse": handleBrowse,
    "/api/projects/scan-suggestions": handleScanSuggestions,
    "/api/log": handleLog,
    "/api/graph": handleGraph,
    "/api/branch-commits": handleBranchCommits,
    "/api/status": handleStatus,
    "/api/diff": handleDiff,
    "/api/branches": handleBranches,
    "/api/branches/recent": handleRecentBranches,
    "/api/refs": handleRefs,
    "/api/file-lines": handleFileLines,
    "/api/file-content": handleFileContent,
    "/api/file-raw": handleFileRaw,
    "/api/media-frame": handleMediaFrame,
    "/api/worktree-statuses": handleWorktreeStatuses,
    "/api/diagnostics": handleDiagnostics,
    "/api/files": handleFiles,
    "/api/logs": handleLogs,
    "/api/detached-files": handleDetachedFiles,
    "/api/detached-file-content": handleDetachedFileContent,
    "/api/external-files": handleExternalFiles,
    "/api/search": handleSearch,
    "/api/search-scopes": handleSearchScopes,
    "/api/file-index": handleFileIndex,
    "/api/schemas/resolve": handleSchemaResolve,
    "/api/wt-json-schema": handleWtJsonSchema,
    "/api/wt-config-raw": handleWtConfigRaw,
    "/api/version": handleGetVersion,
    "/api/update/status": handleGetUpdateStatus,
    "/api/detected-formatters": handleDetectedFormatters,
  },
  POST: {
    "/api/log": handleLogIngest,
    "/api/projects": handleAddProject,
    "/api/projects/detect": handleDetectPath,
    "/api/projects/create": handleCreateProject,
    "/api/projects/clone": handleCloneProject,
    "/api/projects/init": handleInitProject,
    "/api/projects/convert": handleConvertProject,
    "/api/stage": handleStage,
    "/api/unstage": handleUnstage,
    "/api/commit": handleCommit,
    "/api/checkout": handleCheckout,
    "/api/reset": handleReset,
    "/api/cherry-pick": handleCherryPick,
    "/api/revert": handleRevert,
    "/api/branch/create": handleBranchCreate,
    "/api/branch/delete": handleBranchDelete,
    "/api/branch/rename": handleBranchRename,
    "/api/discard": handleDiscard,
    "/api/stage-hunk": handleStageHunk,
    "/api/unstage-hunk": handleUnstageHunk,
    "/api/file-write": handleFileWrite,
    "/api/worktree/plan-add": handlePlanAddWorktree,
    "/api/worktree/create": handleCreateWorktree,
    "/api/worktree/plan-remove": handlePlanRemoveWorktree,
    "/api/worktree/remove": handleRemoveWorktree,
    "/api/files/unwatch": handleFilesUnwatch,
    "/api/files/rename": handleFileRename,
    "/api/files/delete": handleFileDelete,
    "/api/files/move": handleFileMove,
    "/api/files/undo": handleFileUndo,
    "/api/files/redo": handleFileRedo,
    "/api/files/create-file": handleFileCreateFile,
    "/api/files/create-dir": handleFileCreateDir,
    "/api/files/copy": handleFileCopy,
    "/api/detached-file-create": handleDetachedFileCreate,
    "/api/detached-file-move": handleDetachedFileMove,
    "/api/detached-file-delete": handleDetachedFileDelete,
    "/api/detached-file-rename": handleDetachedFileRename,
    "/api/detached-file-copy-to-project": handleDetachedFileCopyToProject,
    "/api/schemas/sync": handleSchemaSync,
    "/api/wt-config-save": handleWtConfigSave,
    "/api/update/check": handleUpdateCheck,
    "/api/update/download": handleUpdateDownload,
    "/api/update/install": handleUpdateInstall,
    "/api/open": handleOpen,
  },
};

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

export async function handleRequest(req: Request, ctx: RouteContext): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const pathname = url.pathname;
  stress.track("api-request", { method, path: pathname });

  // Static route table — checked first so dynamic patterns don't shadow named routes
  const handler = routes[method]?.[pathname];
  if (handler) {
    try {
      return await handler(req, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(message, 500);
    }
  }

  // Dynamic route: /api/projects/:id/delete (delete project from disk)
  const projectDeleteMatch = pathname.match(/^\/api\/projects\/([^/]+)\/delete$/);
  if (projectDeleteMatch?.[1] && req.method === "POST") {
    try {
      return await handleDeleteProjectFromDisk(req, ctx, projectDeleteMatch[1]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(message, 500);
    }
  }

  // Dynamic route: /api/projects/:id/worktrees (list worktrees without switching)
  const projectWtMatch = pathname.match(/^\/api\/projects\/([^/]+)\/worktrees$/);
  if (projectWtMatch?.[1] && req.method === "GET") {
    try {
      const data = await projectStore.loadProjects();
      const project = data.projects.find((p) => p.id === projectWtMatch[1]);
      if (!project) return error("Project not found", 404);
      return await handleProjectWorktrees(project.path, project.isBare ?? false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(message, 500);
    }
  }

  // Dynamic route: /api/projects/:id
  const projectIdMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectIdMatch?.[1]) {
    try {
      return await handleProjectByIdRequest(req, ctx, projectIdMatch[1]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(message, 500);
    }
  }

  // Promote a window's session-scoped layouts to canonical (called on window close)
  if (pathname === "/api/layout/promote" && method === "POST") {
    try {
      const body = await parseBody(req);
      // Strict UUID-v4 shape: prevents LIKE-pattern wildcards (% / _) from a malformed
      // windowId from matching unrelated session rows.
      if (
        typeof body.windowId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.windowId)
      ) {
        return error("Invalid 'windowId' — expected UUID", 400);
      }
      storeDb.promoteLayoutSession(body.windowId);
      return json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(message, 500);
    }
  }

  // Dynamic route: /api/stores/:key
  const storeKeyMatch = pathname.match(/^\/api\/stores\/([^/]+)$/);
  if (storeKeyMatch?.[1]) {
    const storeKey = decodeURIComponent(storeKeyMatch[1]);
    const isSettings = isEncryptedStoreKey(storeKey);
    try {
      if (method === "GET") {
        const value = storeDb.getStore(storeKey);
        return json({ value: isSettings && value ? decryptModelKeys(value) : value });
      }
      if (method === "PUT") {
        const body = await parseBody(req);
        if (typeof body.value !== "string") return error("Missing 'value' string in body", 400);
        const stored = isSettings ? encryptModelKeys(body.value) : body.value;
        storeDb.putStore(storeKey, stored);
        // Broadcast to all clients for cross-tab sync (broadcast plaintext state)
        try {
          const parsed = JSON.parse(body.value);
          if (parsed?.state && typeof parsed.state === "object") {
            const nonce = typeof body.nonce === "string" ? body.nonce : undefined;
            ctx.broadcastAll({
              type: "store_updated",
              key: storeKey,
              state: parsed.state,
              ...(nonce && { nonce }),
            });
          }
        } catch {
          // Skip broadcast on parse failure
        }
        return json({ success: true });
      }
      return error("Method not allowed", 405);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(message, 500);
    }
  }

  // LocalDb routes — scoped to project
  if (pathname.startsWith("/api/localdb")) {
    const resolved = resolveProjectFromReq(req, ctx);
    if (resolved instanceof Response) return resolved;
    try {
      const localDbResponse = await handleLocalDbRequest(req, {
        localDb: resolved.project.localDb,
        onChange: (change) =>
          ctx.broadcastToProject(resolved.project.cwd, {
            type: "localdb_changed",
            projectPath: resolved.project.cwd,
            data: change,
          }),
      });
      if (localDbResponse) return localDbResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(message, 500);
    }
  }

  // Review/comment routes use path-pattern matching — need project from params
  if (
    pathname.startsWith("/api/reviews") ||
    pathname.startsWith("/api/placed-threads") ||
    pathname.startsWith("/api/comments/threads")
  ) {
    const resolved = resolveProjectFromReq(req, ctx);
    if (resolved instanceof Response) return resolved;
    try {
      const reviewResponse = await handleReviewRequest(req, {
        reviewDb: resolved.project.reviewDb,
        cwd: resolved.cwd,
        authorName: resolved.project.authorName,
      });
      if (reviewResponse) return reviewResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(message, 500);
    }
  }

  return error("Not found", 404);
}
