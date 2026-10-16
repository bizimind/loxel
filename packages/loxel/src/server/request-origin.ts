/**
 * Request admission rules for the local server.
 *
 * The server listens on loopback without authentication, so these checks keep web pages (browser
 * tabs and pages inside Loxel's own browser panels) from driving it. Browsers attach `Origin` to
 * every WebSocket upgrade and to every cross-site or state-changing fetch, while native clients
 * (the `loxel` CLI, the Electron main process, curl) send none, so the rules key off that header
 * together with `Host`, `Sec-Fetch-Site`, `Sec-Fetch-Mode` and `Content-Type`.
 *
 * Every rule here describes intended policy; `server.ts` applies them to each incoming request
 * before routing, and `RequestOriginPolicy` lets tests pin the port and dev-mode allowances.
 */

export interface RequestOriginPolicy {
  /** Port the server listens on; `Host` and same-origin `Origin` values must carry it. */
  port: number;
  /** Also accept the Vite dev-server origin, which proxies the renderer in `pnpm run dev:app`. */
  allowDevOrigins: boolean;
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
/** Must match `server.port` in vite.config.ts, which uses `strictPort` so it never drifts. */
const VITE_DEV_PORT = 5173;
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
 * A missing `Origin` means a non-browser client or a same-origin GET and is allowed; browsers
 * always send one on WebSocket upgrades and on cross-origin or state-changing fetches.
 */
function isAllowedOrigin(origin: string | null, policy: RequestOriginPolicy): boolean {
  if (origin === null) return true;
  const allowed = loopbackOrigins(policy.port);
  if (policy.allowDevOrigins) allowed.push(...loopbackOrigins(VITE_DEV_PORT));
  return allowed.includes(origin.toLowerCase());
}

function mimeType(contentType: string | null): string | null {
  const type = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return type ? type : null;
}

/**
 * Decide whether a request may be served. Returns `null` to admit it, otherwise the rejection
 * to send. Applies to HTTP requests and WebSocket upgrades alike:
 *
 * - `Host` must be a loopback host with the server's port (blocks DNS rebinding).
 * - `Origin`, when present, must be the server's own origin (plus the Vite dev origin in dev).
 * - Requests the browser marks `Sec-Fetch-Site: cross-site` are rejected, except top-level
 *   navigations (`Sec-Fetch-Mode: navigate`), so a link into the app still opens it while
 *   cross-site subresource loads and fetches cannot reach endpoints.
 * - State-changing methods must declare `Content-Type: application/json`, which browsers only
 *   send cross-site after a CORS preflight that this server never approves.
 */
export function checkRequest(
  req: Pick<Request, "method" | "headers">,
  policy: RequestOriginPolicy,
): RequestRejection | null {
  const host = req.headers.get("Host");
  const origin = req.headers.get("Origin");
  const details = { host, origin, method: req.method };

  if (!isLoopbackHost(host, policy.port)) {
    return { status: 400, reason: "Invalid Host header", details };
  }
  if (!isAllowedOrigin(origin, policy)) {
    return { status: 403, reason: "Origin not allowed", details };
  }

  const fetchSite = req.headers.get("Sec-Fetch-Site")?.toLowerCase();
  const fetchMode = req.headers.get("Sec-Fetch-Mode")?.toLowerCase();
  if (fetchSite === "cross-site" && fetchMode !== "navigate") {
    return { status: 403, reason: "Cross-site request not allowed", details };
  }

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
