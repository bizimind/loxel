/**
 * The Vite dev server's proxy of `/api` and `/ws` to the Loxel dev server (vite.config.ts). Under
 * the dev app (`dev:app`) it only forwards: the app's main process adds the secret of the server it
 * uses to its windows' requests. In a browser (`pnpm run dev`, `dev:client`), it adds the secret
 * from the token file of a server started without the desktop app, read on every request since
 * such a server makes a new one each time it restarts, but only for the app's own page in the
 * browser that opened the access link Vite prints at startup, which holds a token kept in Vite's
 * memory. A tool sends the server's secret itself (session-client.ts), which the proxy forwards as
 * it is.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { bearer, readSessionToken } from "./app-session";

/** The query parameter of the access link, which carries the token. */
export const DEV_ACCESS_PARAM = "loxel-dev-access";

/** What lets a browser through the proxy: the access link Vite prints, then a cookie. */
export interface DevAccess {
  /** The page at `baseUrl` (Vite's own URL) with this run's token. */
  link: (baseUrl: string) => string;
  /**
   * Vite middleware for the access link: sets the cookie, and redirects to the same page without
   * the token, so it is not left in the address bar or the history.
   */
  middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  /** Whether a request's `Cookie` header holds this run's cookie. */
  admits: (cookieHeader: string | undefined) => boolean;
  /** The cookie's name, which the proxy keeps from the server. */
  cookieName: string;
}

/** The tokens of the dev servers this process runs, by port: see {@link devAccessFor}. */
const TOKENS_KEY = Symbol.for("loxel.devAccessTokens");

/**
 * The access of the Vite dev server on `vitePort`, with a token kept only in this process's
 * memory, and the same for the process's life: Vite evaluates its config again when it restarts on
 * a config change, and a browser that opened the link stays let in.
 */
export function devAccessFor(vitePort: number): DevAccess {
  const holder = globalThis as { [TOKENS_KEY]?: Map<number, string> };
  const tokens = (holder[TOKENS_KEY] ??= new Map());
  let token = tokens.get(vitePort);
  if (!token) {
    token = randomBytes(32).toString("base64url");
    tokens.set(vitePort, token);
  }
  return newDevAccess(vitePort, token);
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * The access of the Vite dev server on `vitePort`, with `token`. The cookie is named by the port
 * because a browser sends a host's cookies to every port of it, so two dev servers side by side
 * each keep their own.
 */
export function newDevAccess(
  vitePort: number,
  token = randomBytes(32).toString("base64url"),
): DevAccess {
  const cookieName = `${DEV_ACCESS_PARAM}-${vitePort}`;
  const tokenDigest = digest(token);
  // Digests, so values of any length or encoding compare in constant time.
  const matches = (value: string | null | undefined) =>
    typeof value === "string" && timingSafeEqual(digest(value), tokenDigest);

  return {
    link: (baseUrl) => {
      const url = new URL(baseUrl);
      url.searchParams.set(DEV_ACCESS_PARAM, token);
      return url.href;
    },
    middleware: (req, res, next) => {
      const url = new URL(req.url ?? "/", "http://vite");
      if (!url.searchParams.has(DEV_ACCESS_PARAM)) {
        next();
        return;
      }
      if (!matches(url.searchParams.get(DEV_ACCESS_PARAM))) {
        res.statusCode = 403;
        res.end(
          "This access link is from an earlier run of the dev server: open the one it printed.",
        );
        return;
      }
      url.searchParams.delete(DEV_ACCESS_PARAM);
      res.statusCode = 302;
      res.setHeader("Set-Cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`);
      res.setHeader("Location", `${url.pathname}${url.search}`);
      res.end();
    },
    admits: (cookieHeader) =>
      cookiePairs(cookieHeader).some(([name, value]) => name === cookieName && matches(value)),
    cookieName,
  };
}

/** The name and value of each cookie in a `Cookie` header. */
function cookiePairs(cookieHeader: string | undefined): [string, string][] {
  return (cookieHeader ?? "")
    .split(";")
    .filter((pair) => pair.trim() !== "")
    .map((pair) => {
      const at = pair.indexOf("=");
      return at === -1 ? [pair.trim(), ""] : [pair.slice(0, at).trim(), pair.slice(at + 1).trim()];
    });
}

/** The part of a proxied request {@link authorizeProxyRequest} reads and writes. */
interface ProxyRequest {
  getHeader: (name: string) => unknown;
  setHeader: (name: string, value: string) => void;
  removeHeader: (name: string) => void;
}

/**
 * What the browser says a request's initiator is (`Sec-Fetch-Site`): the app's own page
 * (`same-origin`), or the user (`none`, a typed address). A page on another port of the same host
 * is `same-site`, and still sends the cookie, which only the port tells apart.
 */
const OWN_REQUEST_SITES = new Set(["same-origin", "none"]);

/**
 * Add the secret of the server for `stateDir` to a request the proxy forwards, when `access` (null
 * under the dev app) admits the browser that sent it, the request comes from the app's own page,
 * and it carries no secret of its own. The access cookie itself never reaches the server.
 */
export function authorizeProxyRequest(
  proxyReq: ProxyRequest,
  req: IncomingMessage,
  access: DevAccess | null,
  stateDir: string,
): void {
  if (!access) return;
  const cookies = cookiePairs(req.headers.cookie).filter(([name]) => name !== access.cookieName);
  if (cookies.length > 0) {
    proxyReq.setHeader("Cookie", cookies.map(([name, value]) => `${name}=${value}`).join("; "));
  } else proxyReq.removeHeader("Cookie");
  if (proxyReq.getHeader("authorization") !== undefined) return;
  const site = req.headers["sec-fetch-site"];
  if (typeof site !== "string" || !OWN_REQUEST_SITES.has(site)) return;
  if (!access.admits(req.headers.cookie)) return;
  const secret = readSessionToken(stateDir);
  if (secret) proxyReq.setHeader("Authorization", bearer(secret));
}
