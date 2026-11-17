/**
 * The Unix socket the `loxel` CLI reaches the server on, beside its loopback TCP port. Only the
 * user's own account can open it: the socket is 0600, in a 0700 directory of the user's
 * (`config.cliSocketPath`, see socket-paths.ts). The newest server takes the socket's name over,
 * whatever is there. See docs/ARCHITECTURE.md#the-cli-socket.
 */
import { type Stats, chmodSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

import { cliSocketTempPath, ensurePrivateDir } from "../socket-paths";

/** A server listening on a socket; Bun's removes the path it was given when it stops. */
interface SocketServer {
  stop: (closeActiveConnections?: boolean) => unknown;
}

/** A server on the CLI socket, to stop without removing a newer server's socket. */
export interface CliSocket {
  /**
   * Stop the server, and remove the socket file if it is still this server's. The server stops
   * even when the file cannot be checked or removed, which then throws.
   */
  stop: () => void;
}

/** The file a path refers to: its device and inode. */
type FileId = Pick<Stats, "dev" | "ino">;

const fileAt = (path: string): FileId | undefined => lstatSync(path, { throwIfNoEntry: false });

/**
 * Listen on the socket at `path` with `listen`, taking its name over from whatever is there: a
 * stale socket file a killed server left, a file that is not a socket, or the live socket of an
 * older server, which keeps the connections it has while new ones come here. The server listens on
 * a temporary name in the same private directory, is made private (0600), and is then renamed to
 * `path`, which replaces the old file in one step. Throws when the directory cannot be set up or
 * the socket cannot be listened on or renamed, leaving `path` as it was.
 */
export function takeOverSocket(path: string, listen: (path: string) => SocketServer): CliSocket {
  ensurePrivateDir(dirname(path));
  const temp = cliSocketTempPath(path);
  const server = listen(temp);
  let own: FileId | undefined;
  try {
    // The socket is created with the umask's mode; its private directory covers the moment until
    // this narrows it.
    chmodSync(temp, 0o600);
    own = fileAt(temp);
    renameSync(temp, path);
  } catch (err) {
    // Stopping removes the temporary name.
    server.stop(true);
    throw err;
  }
  return {
    stop: () => {
      try {
        // A newer server that took the name over owns the file now. Unlinking is not
        // conditional, so one taking it over between the check and the unlink would lose it, but
        // that window is two system calls wide.
        const current = fileAt(path);
        if (own && current?.dev === own.dev && current.ino === own.ino) unlinkSync(path);
      } finally {
        server.stop();
      }
    },
  };
}
