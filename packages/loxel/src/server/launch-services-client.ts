/**
 * Server-side access to macOS LaunchServices ("Open With" app lists and app icons).
 *
 * The native calls run in a separate helper process (this same executable started with
 * LAUNCH_SERVICES_HELPER_FLAG, see launch-services-helper.ts), so a crash in the FFI code
 * only kills the helper. The helper is started on first use, restarted on the next request
 * after it dies, and stopped after a period without requests.
 */
import { stat } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";

import type { Subprocess } from "bun";

import type { OpenInApp, OpenInApps } from "@/api/open-in-model";

import {
  HelperResponseSchema,
  IconResultSchema,
  LAUNCH_SERVICES_HELPER_FLAG,
  RawAppListSchema,
} from "./launch-services-protocol";
import type { HelperOp, HelperRequest, RawAppList } from "./launch-services-protocol";
import { logger } from "./logger";

const log = logger.child("launch-services");

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
/** App lists change when apps are installed or defaults change, so cache them briefly. */
const DEFAULT_APP_LIST_TTL_MS = 60_000;
const MAX_CACHED_ICONS = 256;

type HelperRequestBody = {
  [Op in HelperOp]: Omit<Extract<HelperRequest, { op: Op }>, "id">;
}[HelperOp];

interface PendingRequest {
  op: HelperOp;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: Timer;
}

interface Helper {
  proc: Subprocess<"pipe", "pipe", "inherit">;
  pending: Map<number, PendingRequest>;
}

export interface LaunchServicesClientOptions {
  /** Command that starts the helper. Defaults to re-running this executable in helper mode. */
  command?: string[];
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  appListTtlMs?: number;
}

/** Re-run the current executable (compiled binary, or `bun <entry>` in dev) as the helper. */
function defaultHelperCommand(): string[] {
  const isCompiled = Bun.main.startsWith("/$bunfs/");
  return isCompiled
    ? [process.execPath, LAUNCH_SERVICES_HELPER_FLAG]
    : [process.execPath, Bun.main, LAUNCH_SERVICES_HELPER_FLAG];
}

/**
 * Cache key for app lists. macOS picks apps by file type, which comes from the
 * (case-insensitive) extension; extension-less files are typed by their executable bit.
 * Per-file "Open with" overrides (Finder Get Info) only change the default and are ignored.
 */
export async function appListCacheKey(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  if (ext) return ext;
  const { mode } = await stat(path);
  return mode & 0o111 ? "<executable>" : "<none>";
}

/** Apps embedded inside another bundle (e.g. Xcode's Instruments) are hidden, like Finder does. */
function isNestedBundle(appPath: string): boolean {
  const parent = dirname(appPath);
  return parent.endsWith(".app") || parent.includes(".app/");
}

function toApp(appPath: string): OpenInApp {
  return { path: appPath, name: basename(appPath, ".app") };
}

/** Dedupe, drop nested bundles, pull out the default app and sort the rest by name. */
export function normalizeAppList(raw: RawAppList): OpenInApps {
  const others = new Set<string>();
  for (const appPath of raw.apps) {
    if (appPath !== raw.defaultApp && !isNestedBundle(appPath)) others.add(appPath);
  }
  return {
    defaultApp: raw.defaultApp ? toApp(raw.defaultApp) : null,
    apps: [...others].map(toApp).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export class LaunchServicesClient {
  private readonly command: string[];
  private readonly requestTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly appListTtlMs: number;
  private helper: Helper | null = null;
  private idleTimer: Timer | null = null;
  private nextId = 1;
  private readonly appLists = new Map<string, { value: OpenInApps; expiresAt: number }>();
  private readonly icons = new Map<string, { mtimeMs: number; png: Uint8Array<ArrayBuffer> }>();

  constructor(options: LaunchServicesClientOptions = {}) {
    this.command = options.command ?? defaultHelperCommand();
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.appListTtlMs = options.appListTtlMs ?? DEFAULT_APP_LIST_TTL_MS;
  }

  /** Apps that can open `path` (cached per file type). */
  async appsForFile(path: string): Promise<OpenInApps> {
    const key = await appListCacheKey(path);
    const cached = this.appLists.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const raw = RawAppListSchema.parse(await this.request({ op: "apps", path }));
    const value = normalizeAppList(raw);
    this.appLists.set(key, { value, expiresAt: Date.now() + this.appListTtlMs });
    return value;
  }

  /** Whether `appPath` appeared in an app list this client returned. */
  hasListedApp(appPath: string): boolean {
    for (const { value } of this.appLists.values()) {
      if (value.defaultApp?.path === appPath || value.apps.some((app) => app.path === appPath)) {
        return true;
      }
    }
    return false;
  }

  /** PNG icon of the app bundle at `appPath` (cached until the bundle changes). */
  async appIcon(appPath: string): Promise<Uint8Array<ArrayBuffer>> {
    const { mtimeMs } = await stat(appPath);
    const cached = this.icons.get(appPath);
    if (cached?.mtimeMs === mtimeMs) return cached.png;

    const base64 = IconResultSchema.parse(await this.request({ op: "icon", appPath }));
    const png = new Uint8Array(Buffer.from(base64, "base64"));
    if (this.icons.size >= MAX_CACHED_ICONS) this.icons.clear();
    this.icons.set(appPath, { mtimeMs, png });
    return png;
  }

  /** Stop the helper process, failing any in-flight requests. */
  dispose(): void {
    this.clearIdleTimer();
    if (this.helper) this.stopHelper(this.helper);
  }

  private request(body: HelperRequestBody): Promise<unknown> {
    const helper = this.ensureHelper();
    const id = this.nextId++;
    this.clearIdleTimer();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        helper.pending.delete(id);
        reject(new Error(`LaunchServices helper timed out after ${this.requestTimeoutMs}ms`));
        // A helper that stops answering is likely wedged: replace it on the next request.
        log.warn(`LaunchServices helper timed out on "${body.op}", restarting it`);
        this.stopHelper(helper);
      }, this.requestTimeoutMs);
      helper.pending.set(id, { op: body.op, resolve, reject, timer });

      try {
        helper.proc.stdin.write(`${JSON.stringify({ ...body, id })}\n`);
        void helper.proc.stdin.flush();
      } catch (err) {
        clearTimeout(timer);
        helper.pending.delete(id);
        reject(new Error("Failed to reach LaunchServices helper", { cause: err }));
      }
    });
  }

  private ensureHelper(): Helper {
    if (this.helper) return this.helper;

    const proc = Bun.spawn(this.command, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    const helper: Helper = { proc, pending: new Map() };
    this.helper = helper;
    log.debug(`Started LaunchServices helper (pid ${proc.pid})`);
    void this.readResponses(helper);
    void proc.exited.then(() => this.onExit(helper));
    return helper;
  }

  private async readResponses(helper: Helper): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of helper.proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          this.onResponseLine(helper, buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      }
    } catch (err) {
      // The stream errors when the helper is killed; onExit fails the pending requests.
      log.debug("LaunchServices helper stdout closed", { err });
    }
  }

  private onResponseLine(helper: Helper, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn("Ignoring malformed LaunchServices helper output");
      return;
    }
    const response = HelperResponseSchema.safeParse(parsed);
    if (!response.success) {
      log.warn("Ignoring invalid LaunchServices helper response");
      return;
    }
    const pending = helper.pending.get(response.data.id);
    if (!pending) return;
    helper.pending.delete(response.data.id);
    clearTimeout(pending.timer);
    if (response.data.ok) {
      pending.resolve(response.data.result);
    } else {
      log.warn(`LaunchServices helper "${pending.op}" failed: ${response.data.error}`);
      pending.reject(new Error(response.data.error));
    }
    this.scheduleIdleStop();
  }

  private onExit(helper: Helper): void {
    if (this.helper === helper) {
      this.helper = null;
      this.clearIdleTimer();
    }
    const { exitCode, signalCode } = helper.proc;
    const reason = signalCode ?? `exit code ${exitCode}`;
    if (helper.pending.size > 0 || signalCode !== null || exitCode !== 0) {
      log.warn(`LaunchServices helper exited (${reason}) with ${helper.pending.size} pending`);
    } else {
      log.debug(`LaunchServices helper exited (${reason})`);
    }
    for (const pending of helper.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`LaunchServices helper exited (${reason})`));
    }
    helper.pending.clear();
  }

  private stopHelper(helper: Helper): void {
    if (this.helper === helper) this.helper = null;
    helper.proc.kill();
  }

  private scheduleIdleStop(): void {
    const helper = this.helper;
    if (!helper || helper.pending.size > 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // Closing stdin lets the helper finish its loop and exit cleanly.
      if (this.helper === helper && helper.pending.size === 0) {
        this.helper = null;
        void helper.proc.stdin.end();
      }
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
