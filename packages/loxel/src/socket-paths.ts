/**
 * Where Loxel's Unix sockets are, shared by the processes that listen on them and the clients that
 * find them: the terminal hosts' sockets (terminal-host/host-files.ts) and the server's socket for
 * the `loxel` CLI. Each is in a private directory under the state directory, so only the user's
 * own account can open it. See docs/TERMINAL_HOST.md#files-on-disk and docs/ARCHITECTURE.md.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The longest socket path the platform takes: `sun_path` is 104 bytes on macOS (108 on Linux),
 * terminator included.
 */
const MAX_SOCKET_PATH_BYTES = 103;

const CLI_SOCKET_NAME = "cli.sock";
/** Random bytes in the name a server listens on before it takes the CLI socket's name. */
const TEMP_SUFFIX_BYTES = 4;
/** The longest name in the CLI socket's directory: a server's temporary one, `cli.sock.<hex>`. */
const LONGEST_CLI_SOCKET_NAME = `${CLI_SOCKET_NAME}.${"0".repeat(TEMP_SUFFIX_BYTES * 2)}`;

/** Where a socket directory goes when the state directory is too deep for one. */
interface SocketDirFallback {
  /** Names the directory in the temporary directory: `<prefix>-<hash of the state directory>`. */
  prefix: string;
  stateDir: string;
  tempDir?: string;
}

/**
 * `dir`, unless a socket named `longestName` there would pass the socket path limit, which only a
 * deep `LOXEL_STATE_DIR` override does. Then it is a directory in the temporary directory named by
 * a hash of the state directory, so every process for that state directory finds the same one.
 */
export function socketDir(
  dir: string,
  longestName: string,
  { prefix, stateDir, tempDir = tmpdir() }: SocketDirFallback,
): string {
  if (Buffer.byteLength(join(dir, longestName)) <= MAX_SOCKET_PATH_BYTES) return dir;
  const hash = createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  return join(tempDir, `${prefix}-${hash}`);
}

/**
 * Create a directory for sockets, or check an existing one: it must be a directory of this user's,
 * and is made private (0700), since anyone who can reach a socket in it controls what listens
 * there.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw new Error(`${dir} is not a directory of this user's`);
  }
  if ((stat.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

/**
 * The Unix socket the server for `stateDir` listens on for the `loxel` CLI: `<stateDir>/run/cli.sock`,
 * or in the temporary directory for a state directory too deep for a socket path. The directory is
 * chosen so that {@link cliSocketTempPath}'s names fit too.
 */
export function cliSocketPath(stateDir: string, tempDir = tmpdir()): string {
  const dir = socketDir(join(stateDir, "run"), LONGEST_CLI_SOCKET_NAME, {
    prefix: "loxel-run",
    stateDir,
    tempDir,
  });
  return join(dir, CLI_SOCKET_NAME);
}

/**
 * A fresh name beside the CLI socket at `socketPath` for a server to listen on before it renames
 * the socket to `socketPath` (see server/cli-socket.ts): `cli.sock.<8 hex digits>`.
 */
export function cliSocketTempPath(socketPath: string): string {
  return `${socketPath}.${randomBytes(TEMP_SUFFIX_BYTES).toString("hex")}`;
}
