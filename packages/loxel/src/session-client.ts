/**
 * For tools that drive a server started without the desktop app (tests, e2e, scripts/demo,
 * scripts/network-audit): its session secret, from the token file it writes before it listens
 * (app-session.ts), as the header every `/api` and `/ws` request to it carries.
 */
import { bearer, readSessionToken } from "./app-session";

/** The header that carries the secret of the server for `stateDir`; throws when it wrote none. */
export function sessionAuthorization(stateDir: string): { Authorization: string } {
  const secret = readSessionToken(stateDir);
  if (!secret) throw new Error(`The Loxel server wrote no session token in ${stateDir}`);
  return { Authorization: bearer(secret) };
}

/**
 * A WebSocket from a Bun process to a server, sending `headers` with the upgrade. Bun's constructor
 * takes them, but lib.dom's type, which wins in this package, does not show its options.
 */
export function bunWebSocket(url: string, headers: Record<string, string>): WebSocket {
  const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options: Bun.WebSocketOptions,
  ) => WebSocket;
  return new BunWebSocket(url, { headers });
}
