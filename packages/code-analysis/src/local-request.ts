/**
 * Accept requests only for the local address: the Host must name this server, an Origin, when the
 * browser sends one (always for the reload WebSocket), must be this server's own page, and a
 * cross-site request must be a top-level navigation. Mirrors the checks in Loxel's server
 * (packages/loxel/src/server/request-origin.ts); the packages share no code.
 */
export function isLocalRequest(req: Request, port: number): boolean {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = req.headers.get("host");
  if (host === null || !hosts.includes(host.toLowerCase())) return false;

  const origin = req.headers.get("origin");
  if (origin !== null && !hosts.some((allowed) => origin.toLowerCase() === `http://${allowed}`)) {
    return false;
  }

  const fetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();
  const topLevelNavigation =
    req.headers.get("sec-fetch-mode")?.toLowerCase() === "navigate" &&
    req.headers.get("sec-fetch-dest")?.toLowerCase() === "document";
  return fetchSite !== "cross-site" || topLevelNavigation;
}
