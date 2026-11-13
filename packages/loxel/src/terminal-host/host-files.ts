/**
 * Where terminal hosts keep their files under a state directory, shared by the host that writes
 * them and the server that reads them:
 *
 * - `terminal-host/run/` (0700): each running host's socket `<hostId>.sock` (0600) and its entry
 *   `<hostId>.json`. The socket's handshake is the truth about a host; the entry is a hint, for
 *   finding a host that does not answer.
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
});
export type HostEntry = z.infer<typeof HostEntrySchema>;

export function newHostId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, HOST_ID_LENGTH);
}

export function isHostId(value: string): boolean {
  return HOST_ID.test(value);
}

/**
 * The run directory for `stateDir`. A state directory so deep that a socket in it would pass the
 * socket path limit gets one in the temporary directory instead, named by a hash of its path, so
 * every server for that state directory finds the same one.
 */
export function hostRunDir(stateDir: string, tempDir = tmpdir()): string {
  const preferred = join(stateDir, "terminal-host", "run");
  if (fitsSocketPath(preferred)) return preferred;
  const hash = createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  return join(tempDir, `loxel-terminal-host-${hash}`);
}

function fitsSocketPath(runDir: string): boolean {
  const longest = hostSocketPath(runDir, "0".repeat(HOST_ID_LENGTH));
  return Buffer.byteLength(longest) <= MAX_SOCKET_PATH_BYTES;
}

export function hostSocketPath(runDir: string, hostId: string): string {
  return join(runDir, `${hostId}.sock`);
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
