/**
 * Request admission rules for the local server.
 *
 * On the loopback TCP port, every `/api` and `/ws` request must carry the app's session secret
 * (app-session.ts) as an `Authorization: Bearer` header, which Electron main adds to its own
 * requests and to its windows'. Without it only `GET /api/version` (how the app finds and waits
 * for its server) and the renderer's static files are served. The secret is what proves a request comes from the app; the
 * browser-header rules below stay as defense in depth, keeping web pages (browser tabs and pages
 * inside Loxel's own browser panels, which never get the header) from driving the server. The
 * `Sec-Fetch-Dest` rule also keeps elements of repository content the app window shows, which
 * the window's session authorizes, to the few routes built for them. Browsers
 * attach `Origin` to WebSocket upgrades, CORS-mode fetches and non-GET/HEAD requests, but not to
 * no-cors GET loads or navigations, and native clients send none, so no single header is
 * conclusive: those rules combine `Host`, `Origin`, `Sec-Fetch-Site`, `Sec-Fetch-Mode`,
 * `Sec-Fetch-Dest` and `Content-Type`.
 *
 * The `loxel` CLI does not use the TCP port: it connects to the server's Unix socket, which only
 * the user's own account can open (see cli-socket.ts). The listener a request arrived on, and over
 * TCP its secret, decide its {@link Principal}, and each route lists the principals it serves.
 *
 * Every rule here describes intended policy; `server.ts` applies them to each incoming request
 * before routing, and `RequestOriginPolicy` lets tests pin the port and dev-mode allowances.
 */
import { timingSafeEqual } from "node:crypto";

/**
 * Who a request is from: `app` over the loopback TCP port with the app's session secret (the app's
 * windows and its main process), `anonymous` over that port without it, `cli` over the Unix socket
 * (the `loxel` CLI).
 */
export type Principal = "app" | "anonymous" | "cli";

/**
 * The routes some principal other than `app` may use, by `METHOD /path`, with the principals they
 * serve. Every other endpoint (`/api` and `/ws` paths, WebSocket upgrades included) serves `app`
 * only, and static files serve `app` and `anonymous`.
 */
const ROUTE_PRINCIPALS: ReadonlyMap<string, readonly Principal[]> = new Map([
  // How the app finds and waits for its server (src/electron/main.ts), and what the `loxel` CLI
  // sends: src/cli.ts, src/find-server.ts and src/open-request.ts.
  ["GET /api/version", ["app", "anonymous", "cli"]],
  ["POST /api/open", ["app", "cli"]],
]);
const ENDPOINT_PRINCIPALS: readonly Principal[] = ["app"];
const STATIC_FILE_PRINCIPALS: readonly Principal[] = ["app", "anonymous"];

/**
 * The `Sec-Fetch-Dest` of the app's own requests to endpoints: `fetch` and XHR (`empty`), and
 * WebSockets. Its windows never navigate to one.
 */
const REQUEST_DESTINATIONS: ReadonlySet<string> = new Set(["empty", "websocket"]);

/**
 * The endpoints a page element (`<img>`, `<video>`, `<iframe>`...) may load, by `METHOD /path`,
 * with the destinations each serves. The app window also shows repository content (markdown,
 * drawings, hovers) whose elements its session authorizes like the app's own, so every other
 * endpoint refuses them.
 */
const ELEMENT_DESTINATIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // The media viewer's frame, and the images and videos it shows.
  ["GET /api/file-raw", new Set(["image", "video"])],
  ["GET /api/media-frame", new Set(["iframe"])],
  // Open In menu icons (src/api/client.ts).
  ["GET /api/open-in/app-icon", new Set(["image"])],
]);

/** `/api` and `/ws` paths, matched by prefix as `server.ts` dispatches them. */
function isEndpoint(pathname: string): boolean {
  return pathname.startsWith("/api") || pathname.startsWith("/ws");
}

function servesPrincipal(principal: Principal, method: string, pathname: string): boolean {
  const principals =
    ROUTE_PRINCIPALS.get(`${method.toUpperCase()} ${pathname}`) ??
    (isEndpoint(pathname) ? ENDPOINT_PRINCIPALS : STATIC_FILE_PRINCIPALS);
  return principals.includes(principal);
}

/** Compared in constant time, so the response time says nothing about how much of it matched. */
function isSecret(candidate: string | null | undefined, secret: string): boolean {
  if (!candidate) return false;
  const given = Buffer.from(candidate);
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function bearerToken(authorization: string | null): string | null {
  const match = authorization?.match(/^Bearer +(\S+)$/i);
  return match?.[1] ?? null;
}

/**
 * The principal of a request over the TCP port: `app` when its `Authorization: Bearer` header holds
 * `secret`, `anonymous` otherwise.
 */
export function tcpPrincipal(headers: Headers, secret: string): "app" | "anonymous" {
  return isSecret(bearerToken(headers.get("Authorization")), secret) ? "app" : "anonymous";
}

export interface RequestOriginPolicy {
  /** Port the server listens on; `Host` and same-origin `Origin` values must carry it. */
  port: number;
  /**
   * Port of the Vite dev server whose origin is also accepted (it serves the renderer and proxies
   * to this server in dev mode), or null to accept only the server's own origin.
   */
  viteDevPort: number | null;
}

export interface RequestRejection {
  status: number;
  /** Short, user-safe reason returned as the response body and logged at warn level. */
  reason: string;
  /** Header values worth logging alongside the reason; never includes body or query data. */
  details: Record<string, string | null>;
}

// The server binds 127.0.0.1, but a client may still address it by any loopback name.
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function loopbackOrigins(port: number): string[] {
  return LOOPBACK_HOSTS.map((host) => `http://${host}:${port}`);
}

/** `Host` must name this server: a loopback host with the port the server listens on. */
function isLoopbackHost(host: string | null, port: number): boolean {
  if (!host) return false;
  return LOOPBACK_HOSTS.some((loopback) => host.toLowerCase() === `${loopback}:${port}`);
}

/**
 * Only decides requests that carry an `Origin`. A missing one is ambiguous: a native client, a
 * same-origin GET, or a cross-site no-cors GET (`<img>`, `<script>`, `<video>`) or navigation,
 * which browsers send without `Origin`. Those cross-site cases are rejected by the
 * `Sec-Fetch-Site` rule in `checkRequest`, not here.
 */
function isAllowedOrigin(origin: string | null, policy: RequestOriginPolicy): boolean {
  if (origin === null) return true;
  const allowed = loopbackOrigins(policy.port);
  if (policy.viteDevPort !== null) allowed.push(...loopbackOrigins(policy.viteDevPort));
  return allowed.includes(origin.toLowerCase());
}

function mimeType(contentType: string | null): string | null {
  const type = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return type ? type : null;
}

/** What {@link checkRequest} looks at: the method, the headers and the path. */
export interface AdmissionRequest {
  method: string;
  headers: Headers;
  pathname: string;
}

/**
 * Decide whether a request may be served. Returns `null` to admit it, otherwise the rejection
 * to send. Applies to HTTP requests and WebSocket upgrades alike:
 *
 * - The route must serve the request's principal: `401` for `anonymous`, which lacks the app's
 *   session secret, `403` for any other.
 * - For `app` and `anonymous`, over TCP:
 *   - `Host` must be a loopback host with the server's port (blocks DNS rebinding).
 *   - `Origin`, when present, must be the server's own origin (plus the Vite dev origin in dev).
 *   - Requests the browser marks `Sec-Fetch-Site: cross-site` are rejected, except top-level
 *     document navigations (`Sec-Fetch-Mode: navigate` with `Sec-Fetch-Dest: document`), so a
 *     link into the app still opens it while cross-site fetches and subresource loads, including
 *     `<iframe>`, `<object>` and `<embed>` (navigations whose destination is not `document`),
 *     cannot reach endpoints.
 *   - An endpoint request from a page element or a navigation (`Sec-Fetch-Dest` other than
 *     `empty` or `websocket`) is admitted only on the routes built to be loaded that way
 *     ({@link ELEMENT_DESTINATIONS}).
 * - For `cli`, over the Unix socket, none of those: no browser can connect to a Unix socket, so
 *   there is no page to tell apart, and `Host` names no address there.
 * - State-changing methods must declare `Content-Type: application/json`, which browsers only
 *   send cross-site after a CORS preflight that this server never approves. The socket keeps the
 *   rule too, so every principal sends mutations the same way.
 */
export function checkRequest(
  req: AdmissionRequest,
  principal: Principal,
  policy: RequestOriginPolicy,
): RequestRejection | null {
  const host = req.headers.get("Host");
  const origin = req.headers.get("Origin");
  const details = { principal, host, origin, method: req.method };

  if (!servesPrincipal(principal, req.method, req.pathname)) {
    return principal === "anonymous"
      ? { status: 401, reason: "Missing or invalid app session", details }
      : { status: 403, reason: `Not available to the ${principal} connection`, details };
  }
  const browserRejection = principal === "cli" ? null : checkBrowserRules(req, policy, details);
  if (browserRejection) return browserRejection;

  if (!STATE_CHANGING_METHODS.has(req.method.toUpperCase())) return null;
  const contentType = req.headers.get("Content-Type");
  if (mimeType(contentType) !== "application/json") {
    return {
      status: 415,
      reason: "Content-Type must be application/json",
      details: { ...details, contentType },
    };
  }
  return null;
}

/** The `Host`, `Origin` and `Sec-Fetch-*` rules of {@link checkRequest}, for requests over TCP. */
function checkBrowserRules(
  req: AdmissionRequest,
  policy: RequestOriginPolicy,
  details: RequestRejection["details"],
): RequestRejection | null {
  if (!isLoopbackHost(req.headers.get("Host"), policy.port)) {
    return { status: 400, reason: "Invalid Host header", details };
  }
  if (!isAllowedOrigin(req.headers.get("Origin"), policy)) {
    return { status: 403, reason: "Origin not allowed", details };
  }

  const fetchSite = req.headers.get("Sec-Fetch-Site")?.toLowerCase();
  const fetchMode = req.headers.get("Sec-Fetch-Mode")?.toLowerCase();
  const fetchDest = req.headers.get("Sec-Fetch-Dest")?.toLowerCase();
  const topLevelNavigation = fetchMode === "navigate" && fetchDest === "document";
  if (fetchSite === "cross-site" && !topLevelNavigation) {
    return { status: 403, reason: "Cross-site request not allowed", details };
  }
  if (!isEndpoint(req.pathname) || fetchDest === undefined) return null;
  if (REQUEST_DESTINATIONS.has(fetchDest)) return null;
  const route = `${req.method.toUpperCase()} ${req.pathname}`;
  if (ELEMENT_DESTINATIONS.get(route)?.has(fetchDest)) return null;
  return {
    status: 403,
    reason: "Not available to page elements",
    details: { ...details, fetchDest },
  };
}
