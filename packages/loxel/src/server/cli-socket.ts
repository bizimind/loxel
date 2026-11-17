/**
 * The Unix socket the `loxel` CLI reaches the server on, beside its loopback TCP port. Only the
 * user's own account can open it: the socket is 0600, in a 0700 directory of the user's
 * (`config.cliSocketPath`, see socket-paths.ts). See docs/ARCHITECTURE.md#request-origin-checks.
 */
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

import { ensurePrivateDir } from "../socket-paths";

/** Whether a process accepts connections on the socket at `path`. */
async function socketAnswers(path: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({ unix: path, socket: { data: () => {} } });
    socket.end();
    return true;
  } catch {
    // ECONNREFUSED: a socket file no process listens on, left by one that was killed.
    return false;
  }
}

/**
 * Make way for a socket at `path`: create its private directory and remove a stale socket file a
 * dead server left there. A socket that a live server still answers on (one shutting down, or one
 * sharing this state directory on another port) is left to it, and then this returns false.
 * Throws when the directory cannot be set up or the file cannot be removed.
 */
export async function clearSocketPath(path: string): Promise<boolean> {
  ensurePrivateDir(dirname(path));
  if (!lstatSync(path, { throwIfNoEntry: false })) return true;
  if (await socketAnswers(path)) return false;
  unlinkSync(path);
  return true;
}

/** A server listening on a socket; stopping it removes its socket file. */
interface SocketServer {
  stop: (closeActiveConnections?: boolean) => unknown;
}

/**
 * Listen on the socket at `path`, cleared by {@link clearSocketPath}, with `listen`, and make it
 * private (0600). Throws when it cannot listen.
 */
export function listenOnPrivateSocket<S extends SocketServer>(
  path: string,
  listen: (path: string) => S,
): S {
  const server = listen(path);
  try {
    // The socket is created with the umask's mode; its private directory covers the moment until
    // this narrows it.
    chmodSync(path, 0o600);
  } catch (err) {
    server.stop(true);
    throw err;
  }
  return server;
}
