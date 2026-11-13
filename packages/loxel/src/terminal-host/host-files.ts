/**
 * Where terminal hosts keep their files under a state directory, shared by the host that writes
 * them and the server that reads them:
 *
 * - `terminal-host/run/` (0700): each running host's entry `<hostId>.json` and socket
 *   `<hostId>.sock` (0600). The socket's handshake is the truth about a host; the entry names its
 *   socket and process, for finding a host that does not answer. A state directory too deep for a
 *   socket path keeps its sockets in the temporary directory instead (see {@link hostSocketDir}).
 * - `terminal-host/bin/<hostBuildId>/loxel-terminal-host`: the copy of the bundled binary a
 *   packaged host runs from, so no host runs from the app bundle.
 * - `logs/terminal-host-<hostId>.log`: each host's log.
 *
 * See docs/TERMINAL_HOST.md#files-on-disk.
 */
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/** The name of the host's binary, in the app bundle and in `bin/<hostBuildId>/`. */
export const TERMINAL_HOST_BINARY = "loxel-terminal-host";

/** Host IDs are this many hex characters, which keeps socket paths short. */
const HOST_ID_LENGTH = 8;
const HOST_ID = /^[0-9a-f]{8}$/;

/**
 * The longest socket path the platform takes: `sun_path` is 104 bytes on macOS (108 on Linux),
 * terminator included.
 */
const MAX_SOCKET_PATH_BYTES = 103;

export const HostEntrySchema = z.object({
  pid: z.number().int(),
  build: z.string(),
  protocol: z.string(),
  /** The host's socket: in the run directory, or in the temporary directory's fallback. */
  socket: z.string(),
});
export type HostEntry = z.infer<typeof HostEntrySchema>;

export function newHostId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, HOST_ID_LENGTH);
}

export function isHostId(value: string): boolean {
  return HOST_ID.test(value);
}

/** The run directory for `stateDir`, where every host's entry is. */
export function hostRunDir(stateDir: string): string {
  return join(stateDir, "terminal-host", "run");
}

/**
 * Where the hosts' sockets are: the run directory, unless a socket there would pass the socket
 * path limit, which only a deep `LOXEL_STATE_DIR` override does. Then it is a directory in the
 * temporary directory named by a hash of the state directory, so every server for that state
 * directory finds the same one. The entries stay in the run directory either way.
 */
export function hostSocketDir(stateDir: string, tempDir = tmpdir()): string {
  const runDir = hostRunDir(stateDir);
  if (fitsSocketPath(runDir)) return runDir;
  const hash = createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  return join(tempDir, `loxel-terminal-host-${hash}`);
}

function fitsSocketPath(dir: string): boolean {
  const longest = hostSocketPath(dir, "0".repeat(HOST_ID_LENGTH));
  return Buffer.byteLength(longest) <= MAX_SOCKET_PATH_BYTES;
}

export function hostSocketPath(socketDir: string, hostId: string): string {
  return join(socketDir, `${hostId}.sock`);
}

export function hostEntryPath(runDir: string, hostId: string): string {
  return join(runDir, `${hostId}.json`);
}

export function hostBinDir(stateDir: string): string {
  return join(stateDir, "terminal-host", "bin");
}

export function hostLogsDir(stateDir: string): string {
  return join(stateDir, "logs");
}

export const HOST_LOG_PREFIX = "terminal-host-";

export function hostLogPath(stateDir: string, hostId: string): string {
  return join(hostLogsDir(stateDir), `${HOST_LOG_PREFIX}${hostId}.log`);
}

/**
 * Create the run directory, or check an existing one: it must be a directory of this user's, and
 * is made private (0700), since anyone who can reach a host's socket controls its shells.
 */
export function ensureRunDir(runDir: string): void {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(runDir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw new Error(`Terminal host run directory ${runDir} is not a directory of this user's`);
  }
  if ((stat.mode & 0o777) !== 0o700) chmodSync(runDir, 0o700);
}

/** True while process `pid` runs (EPERM: it runs, as another user). */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
