/**
 * Where main reaches the app's server, and how it proves to the server that it is the app: the
 * session secret (app-session.ts). Each server main starts gets a new one on its channel, and main
 * sends it only once that server has said on the channel that it is listening, and only until the
 * server exits, so nothing else that answers on the port gets it, and a server never accepts one
 * that might have. Main sends it as a Bearer header, on its own requests through
 * {@link serverFetch} and on its windows' through {@link authorizeWindowRequests}, so open windows
 * move to a restarted server's secret on their own.
 */
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import { DEFAULT_SERVER_PORT } from "../app-ports";
import { bearer, readSessionToken } from "../app-session";
import { demoPort } from "../demo-instance";
import { parseServerMessage } from "../parent-channel-protocol";
import { stateDirFor } from "../state-dir";
import { DEMO_INSTANCE, DEV_RENDERER_URL, IS_DEMO, IS_DEV } from "./env";

export const SERVER_PORT = IS_DEMO
  ? demoPort(DEMO_INSTANCE)
  : IS_DEV
    ? DEFAULT_SERVER_PORT.dev
    : DEFAULT_SERVER_PORT.production;
export const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

/** The app's page, which Loxel's windows load: the Vite dev server's in dev, the server's otherwise. */
export const APP_URL = DEV_RENDERER_URL ?? SERVER_URL;

/** The origin Loxel's windows load the app from. */
export const APP_ORIGIN = new URL(APP_URL).origin;

/** How long main waits for a server it started to say it is listening. */
const SERVER_START_TIMEOUT_MS = 10_000;

/** The secret of the server main started, while it is listening; null otherwise. */
let listeningSecret: string | null = null;
/** Whether a server main started has been listening yet, in this run of the app. */
let anyServerListened = false;
/** Resolves once a server main started is listening; replaced when that server is gone. */
let listening = Promise.withResolvers<void>();

/**
 * Follow the channel of a server main started with `secret` (parent-channel-protocol.ts): from its
 * `listening` until the channel closes with the server's exit, requests to the port carry
 * `secret`. Resolves on `listening`; fails when the server exits first (`exited`, with its exit
 * code), or does not say it within {@link SERVER_START_TIMEOUT_MS}, unless main ended the channel
 * to stop it: then it never settles, since the app is quitting. A caller that does not wait for it
 * need not handle the failure.
 */
export function followServerChannel(
  channel: Duplex,
  secret: string,
  exited: Promise<number | null>,
): Promise<void> {
  const started = Promise.withResolvers<void>();
  started.promise.catch(() => {});
  const fail = (error: Error) => {
    if (!channel.writableEnded) started.reject(error);
  };
  createInterface({ input: channel, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
    if (parseServerMessage(line)?.type !== "listening") return;
    listeningSecret = secret;
    anyServerListened = true;
    listening.resolve();
    started.resolve();
  });
  void exited.then((code) =>
    fail(
      new Error(
        `Loxel's server stopped before it was ready (exit code ${code}). If another program is using port ${SERVER_PORT}, quit it and open Loxel again.`,
      ),
    ),
  );
  channel.once("close", () => {
    // A server main started since then has a secret of its own, which stays.
    if (listeningSecret !== secret) return;
    listeningSecret = null;
    listening = Promise.withResolvers();
  });
  void startTimeout().catch(fail);
  return started.promise;
}

/**
 * Whether a server main started has been listening in this run. Until one has, a server that exits
 * fails the launch rather than being restarted: it is the one launch waits for.
 */
export function serverHasListened(): boolean {
  return anyServerListened;
}

/** Wait until a server main started is listening, one restarting after a crash included. */
export async function whenServerListening(): Promise<void> {
  await Promise.race([listening.promise, startTimeout()]);
}

/** Fails once a server has had {@link SERVER_START_TIMEOUT_MS} to start. */
async function startTimeout(): Promise<never> {
  await sleep(SERVER_START_TIMEOUT_MS, undefined, { ref: false });
  throw new Error(`Loxel's server did not start within ${SERVER_START_TIMEOUT_MS}ms`);
}

/**
 * Whether main talks to a dev server started by hand (`pnpm run dev:server`), which has a secret of
 * its own in its token file, rather than to one it started.
 */
let serverStartedByHand = false;

export function setServerStartedByHand(byHand: boolean): void {
  serverStartedByHand = byHand;
}

/**
 * The secret of the server main talks to now. A dev server started by hand gets a new one each
 * time it restarts, so its file is read on every request.
 */
function currentSecret(): string | null {
  if (!serverStartedByHand) return listeningSecret;
  return readSessionToken(stateDirFor("dev"));
}

/** The header that carries the current server's secret, for requests main makes to it. */
export function serverAuthorization(): Record<string, string> {
  const secret = currentSecret();
  return secret ? { Authorization: bearer(secret) } : {};
}

/** What {@link carriesSecret} looks at in a request the windows' session sends. */
export interface WindowRequest {
  url: string;
  /** The type of the web contents that sent it (`window`, `webview`...), when Electron knows. */
  contentsType?: string;
  /** The origin of the frame that sent it, when Electron knows: none for a worker's request. */
  frameOrigin?: string;
  /** Electron's resource type: `subFrame` for a frame's own navigation. */
  resourceType?: string;
  /** The origin of that frame's parent, the document that embeds it. */
  parentOrigin?: string;
}

/**
 * Whether a request from the windows' session gets the secret: an `/api` or `/ws` request to
 * `appOrigin` (HTTP or WebSocket), from an app window, not a `<webview>`, and from a frame of the
 * app's own origin, not one a page embedded from elsewhere. A frame's navigation is the embedding
 * document's: the media viewer loads its SVG frame, sandboxed into an opaque origin, from the
 * server, while what that frame's own scripts request gets nothing.
 */
export function carriesSecret(req: WindowRequest, appOrigin: string): boolean {
  const url = new URL(req.url);
  const wsOrigin = `ws://${new URL(appOrigin).host}`;
  if (url.origin !== appOrigin && url.origin !== wsOrigin) return false;
  if (!url.pathname.startsWith("/api") && !url.pathname.startsWith("/ws")) return false;
  if (req.contentsType !== undefined && req.contentsType !== "window") return false;
  if (req.frameOrigin === undefined || req.frameOrigin === appOrigin) return true;
  return req.resourceType === "subFrame" && req.parentOrigin === appOrigin;
}

/**
 * Add the secret to the requests the app's windows send to `appOrigin`, the server's or in dev the
 * Vite dev server's, which proxies to it (see {@link carriesSecret}). It never reaches another
 * origin, another port on the same host included, as a cookie would, and the renderer's script
 * never sees it. Browser panels have a session of their own, without it.
 */
export function authorizeWindowRequests(windows: Electron.Session, appOrigin: string): void {
  const { hostname } = new URL(appOrigin);
  windows.webRequest.onBeforeSendHeaders(
    // Narrowed to the host here; carriesSecret checks the rest.
    { urls: [`http://${hostname}/*`, `ws://${hostname}/*`] },
    (details, callback) => {
      const request = {
        url: details.url,
        contentsType: details.webContents?.getType(),
        frameOrigin: details.frame?.origin,
        resourceType: details.resourceType,
        parentOrigin: details.frame?.parent?.origin,
      };
      const headers = carriesSecret(request, appOrigin) ? serverAuthorization() : {};
      callback({ requestHeaders: { ...details.requestHeaders, ...headers } });
    },
  );
}

/** A request from main to its server at `path` (`/api/...`), carrying the session secret. */
export function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(serverAuthorization())) headers.set(name, value);
  return fetch(`${SERVER_URL}${path}`, { ...init, headers });
}
