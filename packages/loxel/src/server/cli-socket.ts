/**
 * The Unix socket the `loxel` CLI reaches the server on, beside its loopback TCP port. Only the
 * user's own account can open it: the socket is 0600, in a 0700 directory of the user's
 * (`config.cliSocketPath`, see socket-paths.ts). The newest server takes the socket's name over,
 * whatever is there. See docs/ARCHITECTURE.md#the-cli-socket.
 */
import { chmodSync, renameSync } from "node:fs";
import { dirname } from "node:path";

import { cliSocketTempPath, ensurePrivateDir } from "../socket-paths";

/** A server listening on a socket; Bun's removes the path it was given when it stops. */
interface SocketServer {
  stop: (closeActiveConnections?: boolean) => unknown;
}

/**
 * Listen on the socket at `path` with `listen`, taking its name over from whatever is there: a
 * stale socket file a stopped or killed server left, a file that is not a socket, or the live
 * socket of an older server, which keeps the connections it has while new ones come here. The
 * server listens on a temporary name in the same private directory, is made private (0600), and is
 * then renamed to `path`, which replaces the old file in one step. Stopping the returned server
 * leaves `path` behind: the next server replaces it, and the CLI takes a refused connection as no
 * server. Throws when the directory cannot be set up or the socket cannot be listened on or
 * renamed, leaving `path` as it was.
 */
export function takeOverSocket<S extends SocketServer>(
  path: string,
  listen: (path: string) => S,
): S {
  ensurePrivateDir(dirname(path));
  const temp = cliSocketTempPath(path);
  const server = listen(temp);
  try {
    // The socket is created with the umask's mode; its private directory covers the moment until
    // this narrows it.
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (err) {
    // Stopping removes the temporary name.
    server.stop(true);
    throw err;
  }
  return server;
}
