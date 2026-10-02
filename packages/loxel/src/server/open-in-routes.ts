/**
 * "Open In" routes (macOS): reveal files and folders in Finder and open them in another
 * application. File app lists and icons come from LaunchServicesClient, folder apps from a
 * curated list (folder-apps.ts); Finder actions go through `open`.
 */
import { stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

import { OpenWithAppRequestSchema, RevealInFinderRequestSchema } from "@/api/open-in-model";
import type { OpenInApp, OpenInApps } from "@/api/open-in-model";

import type { LaunchServicesClient } from "./launch-services-client";
import { error, json } from "./response-helpers";

export interface OpenInRouteContext {
  /** True when `path` is a file or folder Loxel manages (worktree, draft or external file). */
  isManagedPath: (path: string) => boolean;
  launchServices: Pick<LaunchServicesClient, "appsForFile" | "appIcon" | "hasListedApp">;
  /** Installed apps that can open folders (terminals and editors). */
  folderApps: () => Promise<OpenInApp[]>;
  /** Runs macOS `open` with the given arguments; rejects with its stderr on failure. */
  runOpen: (args: string[]) => Promise<void>;
}

export async function runOpenCommand(args: string[]): Promise<void> {
  const proc = Bun.spawn(["/usr/bin/open", ...args], { stdout: "ignore", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `open exited with code ${exitCode}`);
}

function isNormalizedAbsolute(path: string): boolean {
  return isAbsolute(path) && normalize(path) === path;
}

/** Validate a client-supplied path: absolute, managed by Loxel, and present on disk. */
async function resolveTarget(
  ctx: OpenInRouteContext,
  path: string | null,
): Promise<{ path: string; isDirectory: boolean } | Response> {
  if (!path) return error("Missing path");
  if (!isNormalizedAbsolute(path)) return error("Path must be absolute");
  if (!ctx.isManagedPath(path)) return error("Path is not part of an open project", 404);
  const info = await stat(path).catch(() => null);
  if (!info) return error("File not found", 404);
  return { path, isDirectory: info.isDirectory() };
}

/**
 * POST bodies must be declared as JSON. Browsers only send that content type cross-site after
 * a CORS preflight, which this server never approves, so other web pages can't trigger these
 * actions with a plain form-style POST.
 */
async function readJsonBody(req: Request): Promise<unknown> {
  const mimeType = req.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mimeType !== "application/json") return null;
  return req.json().catch(() => null);
}

async function appsFor(
  ctx: OpenInRouteContext,
  target: { path: string; isDirectory: boolean },
): Promise<OpenInApps> {
  if (target.isDirectory) return { defaultApp: null, apps: await ctx.folderApps() };
  return ctx.launchServices.appsForFile(target.path);
}

/** GET /api/open-in/apps?path= */
async function handleListApps(req: Request, ctx: OpenInRouteContext): Promise<Response> {
  const target = await resolveTarget(ctx, new URL(req.url).searchParams.get("path"));
  if (target instanceof Response) return target;
  return json(await appsFor(ctx, target));
}

/** GET /api/open-in/app-icon?app= */
async function handleAppIcon(req: Request, ctx: OpenInRouteContext): Promise<Response> {
  const appPath = new URL(req.url).searchParams.get("app");
  if (!appPath || !isNormalizedAbsolute(appPath) || !appPath.endsWith(".app")) {
    return error("Invalid app path");
  }
  // Only icons of apps this API listed, so other pages can't probe which apps are installed.
  const listed =
    ctx.launchServices.hasListedApp(appPath) ||
    (await ctx.folderApps()).some((app) => app.path === appPath);
  if (!listed) return error("App not found", 404);
  const png = await ctx.launchServices.appIcon(appPath);
  return new Response(png, {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" },
  });
}

/** POST /api/open-in/reveal { path } */
async function handleReveal(req: Request, ctx: OpenInRouteContext): Promise<Response> {
  const body = RevealInFinderRequestSchema.safeParse(await readJsonBody(req));
  if (!body.success) return error("Invalid request");
  const target = await resolveTarget(ctx, body.data.path);
  if (target instanceof Response) return target;
  await ctx.runOpen(["-R", target.path]);
  return json({ success: true });
}

/** POST /api/open-in/open { path, appPath } — files and folders */
async function handleOpenWith(req: Request, ctx: OpenInRouteContext): Promise<Response> {
  const body = OpenWithAppRequestSchema.safeParse(await readJsonBody(req));
  if (!body.success) return error("Invalid request");
  const target = await resolveTarget(ctx, body.data.path);
  if (target instanceof Response) return target;

  // Only launch apps this route offers for the target, never an arbitrary executable.
  const { defaultApp, apps } = await appsFor(ctx, target);
  const offered = [defaultApp, ...apps].some((app) => app?.path === body.data.appPath);
  if (!offered) return error("This app cannot open the file");

  await ctx.runOpen(["-a", body.data.appPath, target.path]);
  return json({ success: true });
}

/** Route "Open In" requests. Returns null if the path doesn't match. */
export async function handleOpenInRequest(
  req: Request,
  ctx: OpenInRouteContext,
): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  const method = req.method;

  if (method === "GET" && pathname === "/api/open-in/apps") return handleListApps(req, ctx);
  if (method === "GET" && pathname === "/api/open-in/app-icon") return handleAppIcon(req, ctx);
  if (method === "POST" && pathname === "/api/open-in/reveal") return handleReveal(req, ctx);
  if (method === "POST" && pathname === "/api/open-in/open") return handleOpenWith(req, ctx);
  return null;
}
