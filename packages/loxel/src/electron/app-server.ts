/**
 * Where main reaches the app's server, and how it proves to the server that it is the app: the
 * session secret (app-session.ts), generated once per run. Every server the app starts gets it on
 * its channel, a restart after a crash included, so open windows keep working. Main sends it as a
 * Bearer header, on its own requests through {@link serverFetch} and on its windows' through
 * {@link authorizeWindowRequests}.
 */
import { DEFAULT_SERVER_PORT } from "../app-ports";
import { bearer, newSessionSecret, readSessionToken } from "../app-session";
import { demoPort } from "../demo-instance";
import { stateDirFor } from "../state-dir";
import { DEMO_INSTANCE, IS_DEMO, IS_DEV } from "./env";

export const SERVER_PORT = IS_DEMO
  ? demoPort(DEMO_INSTANCE)
  : IS_DEV
    ? DEFAULT_SERVER_PORT.dev
    : DEFAULT_SERVER_PORT.production;
export const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

/** The secret this run of the app gives the servers it starts. */
export const APP_SESSION_SECRET = newSessionSecret();

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
  if (!serverStartedByHand) return APP_SESSION_SECRET;
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
