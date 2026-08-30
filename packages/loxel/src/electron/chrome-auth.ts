import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type { CookiesSetDetails } from "electron";

import { isHttpUrl } from "../url-utils";
import { ChromeCdpPipe } from "./chrome-cdp";

const CHROME_EXECUTABLES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
];
const PROFILE_PREFIX = "loxel-chrome-auth-";
const STARTUP_TIMEOUT_MS = 10_000;

export type ElectronCookieDetails = CookiesSetDetails;

export interface ChromeCookieStore {
  set(details: ElectronCookieDetails): Promise<void>;
  flushStore(): Promise<void>;
}

export type ChromeAuthResult =
  | {
      status: "success";
      finalUrl: string;
      importedCount: number;
      skippedCount: number;
      persistence: "persistent" | "session-only";
    }
  | { status: "cancelled" }
  | {
      status: "error";
      code:
        | "unsupported-platform"
        | "invalid-url"
        | "chrome-not-found"
        | "busy"
        | "chrome-closed"
        | "no-cookies"
        | "failed";
      message: string;
    };

export interface ChromeAuthConfirmation {
  confirmImport(originalOrigin: string): Promise<boolean>;
  confirmOriginChange(originalOrigin: string, finalOrigin: string): Promise<boolean>;
}

interface ActiveFlow {
  abortController: AbortController;
  child: ChildProcess | null;
  cdp: ChromeCdpPipe | null;
  profileDir: string | null;
  cleanupPromise: Promise<void> | null;
  finishedPromise: Promise<void>;
  finish: () => void;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

export class ChromeAuthManager {
  private activeFlow: ActiveFlow | null = null;

  constructor(private readonly cookieStore: ChromeCookieStore) {}

  get isActive(): boolean {
    return this.activeFlow !== null;
  }

  async authenticate(
    targetUrl: string,
    confirmation: ChromeAuthConfirmation,
    ownerSignal?: AbortSignal,
  ): Promise<ChromeAuthResult> {
    if (process.platform !== "darwin") {
      return errorResult(
        "unsupported-platform",
        "Chrome authentication is currently available on macOS only.",
      );
    }
    if (this.activeFlow) {
      return errorResult("busy", "Another Chrome authentication is already in progress.");
    }

    let canonicalUrl: URL;
    try {
      canonicalUrl = validateTargetUrl(targetUrl);
    } catch {
      return errorResult(
        "invalid-url",
        "Open an HTTP or HTTPS page before authenticating with Chrome.",
      );
    }

    let finish!: () => void;
    const finishedPromise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const flow: ActiveFlow = {
      abortController: new AbortController(),
      child: null,
      cdp: null,
      profileDir: null,
      cleanupPromise: null,
      finishedPromise,
      finish,
    };
    this.activeFlow = flow;

    const abortFromOwner = () => flow.abortController.abort();
    ownerSignal?.addEventListener("abort", abortFromOwner, { once: true });
    if (ownerSignal?.aborted) abortFromOwner();

    const handleChildProcessError = () => {
      // CDP closure maps launch failures to a renderer-safe result.
    };

    let result: ChromeAuthResult;
    let stage = "locating Chrome";
    try {
      throwIfAborted(flow.abortController.signal);
      const chromeExecutable = await findChromeExecutable();
      throwIfAborted(flow.abortController.signal);
      if (!chromeExecutable) throw new ChromeNotFoundError();

      stage = "creating the private profile";
      flow.profileDir = await createPrivateProfileDirectory();
      throwIfAborted(flow.abortController.signal);

      stage = "launching Chrome";
      flow.child = spawnChrome(chromeExecutable, flow.profileDir, canonicalUrl.href);
      flow.child.on("error", handleChildProcessError);
      const { commandStream, responseStream } = getCdpStreams(flow.child);
      flow.cdp = new ChromeCdpPipe(commandStream, responseStream);

      stage = "waiting for Chrome";
      await waitForChromeReady(flow.cdp, flow.child, flow.abortController.signal);
      const initialTarget = await findInitialPageTarget(
        flow.cdp,
        canonicalUrl,
        flow.abortController.signal,
      );

      stage = "waiting for import confirmation";
      const shouldImport = await abortable(
        confirmation.confirmImport(canonicalUrl.origin),
        flow.abortController.signal,
      );
      if (!shouldImport) {
        result = { status: "cancelled" };
      } else {
        stage = "resolving the authenticated page";
        const finalTarget = await resolveFinalPageTarget(flow.cdp, initialTarget.targetId);
        const finalUrl = validateTargetUrl(finalTarget.url);

        stage = "confirming the authenticated site";
        if (
          finalUrl.origin !== canonicalUrl.origin &&
          !(await abortable(
            confirmation.confirmOriginChange(canonicalUrl.origin, finalUrl.origin),
            flow.abortController.signal,
          ))
        ) {
          result = { status: "cancelled" };
        } else {
          stage = "importing cookies";
          result = await this.importCookies(
            flow.cdp,
            finalTarget.targetId,
            [canonicalUrl, finalUrl],
            flow.abortController.signal,
          );
          if (result.status === "success") result.finalUrl = finalUrl.href;
        }
      }
    } catch (caught) {
      reportUnexpectedFailure(caught, flow, stage);
      result = mapFailure(caught, flow);
    } finally {
      ownerSignal?.removeEventListener("abort", abortFromOwner);
      flow.child?.removeListener("error", handleChildProcessError);
      await this.cleanup(flow);
      if (this.activeFlow === flow) this.activeFlow = null;
      flow.finish();
    }

    return result;
  }

  async cancelActive(): Promise<void> {
    const flow = this.activeFlow;
    if (!flow) return;
    flow.abortController.abort();
    await this.cleanup(flow);
    await flow.finishedPromise;
  }

  private async importCookies(
    cdp: ChromeCdpPipe,
    targetId: string,
    allowedUrls: URL[],
    signal: AbortSignal,
  ): Promise<ChromeAuthResult> {
    const attachResult = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = readStringProperty(attachResult, "sessionId");
    if (!sessionId) throw new Error("Chrome page connection failed");

    await cdp.send("Network.enable", {}, { sessionId });
    const cookieResult = await cdp.send("Network.getAllCookies", {}, { sessionId });
    const cookies = readCookies(cookieResult);
    throwIfAborted(signal);

    const mapped = cookies.map((cookie) => mapChromeCookie(cookie, allowedUrls));
    const supported = mapped.filter((cookie): cookie is ElectronCookieDetails => cookie !== null);
    let skippedCount = cookies.length - supported.length;
    if (supported.length === 0) {
      return errorResult(
        "no-cookies",
        "No supported cookies were found for the authenticated site.",
      );
    }

    // Once mutation starts, complete every write and flush before honoring process shutdown.
    // This avoids leaving the persistent partition half-written on cancellation.
    throwIfAborted(signal);
    let importedCount = 0;
    for (const cookie of supported) {
      try {
        await this.cookieStore.set(cookie);
        importedCount++;
      } catch {
        skippedCount++;
      }
    }

    if (importedCount === 0) {
      return errorResult(
        "failed",
        "Supported cookies were found, but Loxel could not import them.",
      );
    }

    let persistence: "persistent" | "session-only" = "persistent";
    try {
      await this.cookieStore.flushStore();
    } catch {
      persistence = "session-only";
    }
    return {
      status: "success",
      finalUrl: allowedUrls.at(-1)!.href,
      importedCount,
      skippedCount,
      persistence,
    };
  }

  private cleanup(flow: ActiveFlow): Promise<void> {
    if (flow.cleanupPromise) return flow.cleanupPromise;
    flow.cleanupPromise = cleanupFlow(flow);
    return flow.cleanupPromise;
  }
}

export function validateTargetUrl(input: string): URL {
  if (typeof input !== "string" || input.length === 0 || input.length > 4_096) {
    throw new Error("Invalid target URL");
  }
  const url = new URL(input);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new Error("Invalid target URL");
  }
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed");
  url.hash = "";
  return url;
}

export function cookieDomainMatches(hostname: string, cookieDomain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const domain = cookieDomain.toLowerCase().replace(/^\./, "");
  if (!host || !domain || domain.endsWith(".")) return false;
  if (isIpAddress(host)) return host === domain;
  return host === domain || host.endsWith(`.${domain}`);
}

export function mapChromeCookie(
  value: unknown,
  allowedUrls: URL[],
  nowSeconds = Date.now() / 1_000,
): ElectronCookieDetails | null {
  if (!value || typeof value !== "object") return null;
  const cookie = value as Record<string, unknown>;
  if ("partitionKey" in cookie || cookie.partitionKeyOpaque === true) return null;
  if (typeof cookie.name !== "string" || cookie.name.length === 0) return null;
  if (typeof cookie.value !== "string" || typeof cookie.domain !== "string") return null;
  if (typeof cookie.path !== "string" || !cookie.path.startsWith("/")) return null;
  if (typeof cookie.secure !== "boolean" || typeof cookie.httpOnly !== "boolean") return null;

  const rawDomain = cookie.domain.toLowerCase();
  const hostOnly = !rawDomain.startsWith(".");
  const normalizedDomain = rawDomain.replace(/^\./, "");
  if (!normalizedDomain || normalizedDomain.endsWith(".")) return null;

  const target = allowedUrls.find((url) => cookieDomainMatches(url.hostname, rawDomain));
  if (!target) return null;
  if (hostOnly && target.hostname.toLowerCase() !== normalizedDomain) return null;

  const secure = cookie.secure;
  if (cookie.name.startsWith("__Secure-") && !secure) return null;
  if (
    cookie.name.startsWith("__Host-") &&
    (!secure || !hostOnly || cookie.path !== "/" || target.hostname !== normalizedDomain)
  ) {
    return null;
  }

  const sameSite = mapSameSite(cookie.sameSite);
  if (sameSite === "no_restriction" && !secure) return null;

  const details: ElectronCookieDetails = {
    url: `${secure ? "https:" : target.protocol}//${target.host}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure,
    httpOnly: cookie.httpOnly,
    sameSite,
  };
  if (!hostOnly) details.domain = rawDomain;

  if (cookie.session !== true) {
    if (typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires)) return null;
    if (cookie.expires <= nowSeconds) return null;
    details.expirationDate = cookie.expires;
  }

  return details;
}

async function findChromeExecutable(): Promise<string | null> {
  for (const executable of CHROME_EXECUTABLES) {
    try {
      const info = await stat(executable);
      if (!info.isFile()) continue;
      await access(executable, fsConstants.X_OK);
      return executable;
    } catch {
      // Try the next known installation location.
    }
  }
  return null;
}

async function createPrivateProfileDirectory(): Promise<string> {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), PROFILE_PREFIX));
  await chmod(profileDir, 0o700);
  return profileDir;
}

function spawnChrome(executable: string, profileDir: string, targetUrl: string): ChildProcess {
  const child = spawn(
    executable,
    [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-mode",
      "--new-window",
      targetUrl,
    ],
    { shell: false, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  child.stderr?.resume();
  return child;
}

function getCdpStreams(child: ChildProcess): { commandStream: Writable; responseStream: Readable } {
  const commandStream = child.stdio[3];
  const responseStream = child.stdio[4];
  if (!commandStream || !responseStream) throw new Error("Chrome debugging pipes are unavailable");
  return { commandStream: commandStream as Writable, responseStream: responseStream as Readable };
}

async function waitForChromeReady(
  cdp: ChromeCdpPipe,
  child: ChildProcess,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (child.exitCode !== null || child.signalCode !== null) throw new ChromeClosedError();
    try {
      await cdp.send("Browser.getVersion", {}, { timeoutMs: 500 });
      return;
    } catch (error) {
      throwIfAborted(signal);
      if (child.exitCode !== null || child.signalCode !== null || cdp.isClosed) {
        throw new ChromeClosedError("Chrome closed before it became ready", { cause: error });
      }
      await delay(100, undefined, { signal });
    }
  }
  throw new Error("Chrome did not become ready");
}

async function findInitialPageTarget(
  cdp: ChromeCdpPipe,
  targetUrl: URL,
  signal: AbortSignal,
): Promise<TargetInfo> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const targets = await getTargets(cdp);
    const pages = targets.filter(isPageTarget);
    const exact = pages.find((target) => stripHash(target.url) === targetUrl.href);
    if (exact) return exact;
    if (pages.length === 1) return pages[0]!;
    await delay(100, undefined, { signal });
  }
  throw new Error("Chrome page did not become ready");
}

async function getTargets(cdp: ChromeCdpPipe): Promise<TargetInfo[]> {
  const result = await cdp.send("Target.getTargets");
  if (!result || typeof result !== "object") return [];
  const targetInfos = (result as Record<string, unknown>).targetInfos;
  if (!Array.isArray(targetInfos)) return [];
  return targetInfos.flatMap((target) => {
    const parsed = parseTargetInfo(target);
    return parsed ? [parsed] : [];
  });
}

async function resolveFinalPageTarget(
  cdp: ChromeCdpPipe,
  initialTargetId: string,
): Promise<TargetInfo> {
  const pages = (await getTargets(cdp)).filter(isPageTarget);
  const replacementPages = pages.filter((target) => target.targetId !== initialTargetId);
  if (replacementPages.length === 1) return replacementPages[0]!;

  const initialTarget = pages.find((target) => target.targetId === initialTargetId);
  if (initialTarget && replacementPages.length === 0) return initialTarget;
  if (pages.length === 1) return pages[0]!;
  throw new Error("Close extra Chrome tabs before importing the session");
}

function parseTargetInfo(value: unknown): TargetInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.targetId !== "string" ||
    typeof record.type !== "string" ||
    typeof record.url !== "string"
  ) {
    return null;
  }
  return { targetId: record.targetId, type: record.type, url: record.url };
}

function isPageTarget(target: TargetInfo): boolean {
  return target.type === "page" && isHttpUrl(target.url);
}

function readCookies(value: unknown): unknown[] {
  if (!value || typeof value !== "object") throw new Error("Chrome returned invalid cookies");
  const cookies = (value as Record<string, unknown>).cookies;
  if (!Array.isArray(cookies)) throw new Error("Chrome returned invalid cookies");
  return cookies;
}

function readStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : null;
}

function mapSameSite(value: unknown): ElectronCookieDetails["sameSite"] {
  switch (value) {
    case "Strict":
      return "strict";
    case "Lax":
      return "lax";
    case "None":
      return "no_restriction";
    default:
      return "unspecified";
  }
}

async function cleanupFlow(flow: ActiveFlow): Promise<void> {
  if (flow.cdp) {
    try {
      await flow.cdp.send("Browser.close", {}, { timeoutMs: 1_000 });
    } catch {
      // Chrome may already be gone.
    }
    flow.cdp.close();
  }

  const child = flow.child;
  if (child && child.exitCode === null && child.signalCode === null) {
    if (!(await waitForExit(child, 1_000))) {
      child.kill("SIGTERM");
      if (!(await waitForExit(child, 1_000))) child.kill("SIGKILL");
    }
  }

  if (flow.profileDir && isOwnedProfileDirectory(flow.profileDir)) {
    try {
      await rm(flow.profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // The OS temporary directory is the final containment boundary after cleanup retries.
    }
  }
}

function isOwnedProfileDirectory(profileDir: string): boolean {
  return (
    path.dirname(profileDir) === os.tmpdir() && path.basename(profileDir).startsWith(PROFILE_PREFIX)
  );
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("Chrome authentication failed"));
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Chrome authentication was cancelled");
}

function stripHash(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

function isIpAddress(hostname: string): boolean {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(unwrapped) !== 0;
}

function errorResult(
  code: Extract<ChromeAuthResult, { status: "error" }>["code"],
  message: string,
): ChromeAuthResult {
  return { status: "error", code, message };
}

function reportUnexpectedFailure(caught: unknown, flow: ActiveFlow, stage: string): void {
  if (
    flow.abortController.signal.aborted ||
    caught instanceof ChromeNotFoundError ||
    caught instanceof ChromeClosedError
  ) {
    return;
  }

  const errorType = caught instanceof Error ? caught.name : typeof caught;
  console.error(`[electron] Chrome authentication failed while ${stage} (${errorType})`);
}

function mapFailure(caught: unknown, flow: ActiveFlow): ChromeAuthResult {
  if (flow.abortController.signal.aborted) return { status: "cancelled" };
  if (caught instanceof ChromeNotFoundError) {
    return errorResult("chrome-not-found", "Google Chrome was not found in Applications.");
  }
  if (
    caught instanceof ChromeClosedError ||
    (flow.child && (flow.child.exitCode !== null || flow.child.signalCode !== null))
  ) {
    return errorResult("chrome-closed", "Chrome closed before the session was imported.");
  }
  return errorResult("failed", "Chrome authentication failed. Please try again.");
}

class ChromeNotFoundError extends Error {}

class ChromeClosedError extends Error {
  constructor(message = "Chrome closed", options?: ErrorOptions) {
    super(message, options);
  }
}
