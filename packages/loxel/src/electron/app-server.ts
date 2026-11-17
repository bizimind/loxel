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
import { DEFAULT_STATE_DIR } from "../state-dir";
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
  return readSessionToken(process.env.LOXEL_STATE_DIR ?? DEFAULT_STATE_DIR.dev);
}

/** The header that carries the current server's secret, for requests main makes to it. */
export function serverAuthorization(): Record<string, string> {
  const secret = currentSecret();
  return secret ? { Authorization: bearer(secret) } : {};
}

/**
 * Add the secret to every request the app's windows send to `appOrigin`: the server's, or in dev
 * the Vite dev server's, which proxies to it. HTTP and WebSocket alike, frames included, and no
 * other origin, so it never reaches another port on the same host (as a cookie would) and the
 * renderer's script never sees it. Browser panels have a session of their own, without it.
 */
export function authorizeWindowRequests(windows: Electron.Session, appOrigin: string): void {
  const { hostname, host } = new URL(appOrigin);
  const wsOrigin = `ws://${host}`;
  windows.webRequest.onBeforeSendHeaders(
    // Narrowed to the host here; the port is checked below.
    { urls: [`http://${hostname}/*`, `ws://${hostname}/*`] },
    (details, callback) => {
      const { origin } = new URL(details.url);
      if (origin !== appOrigin && origin !== wsOrigin) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      callback({ requestHeaders: { ...details.requestHeaders, ...serverAuthorization() } });
    },
  );
}

/** A request from main to its server at `path` (`/api/...`), carrying the session secret. */
export function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(serverAuthorization())) headers.set(name, value);
  return fetch(`${SERVER_URL}${path}`, { ...init, headers });
}
