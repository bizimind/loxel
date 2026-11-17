/**
 * How the `loxel` CLI finds the Loxel server: on the server's Unix socket, which only the user's
 * own account can open (see src/server/cli-socket.ts). The CLI never uses the server's TCP port.
 * See docs/TERMINALS.md#the-loxel-cli.
 */
import { lstatSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { cliSocketPath } from "./socket-paths";
import { DEFAULT_STATE_DIR } from "./state-dir";

type Env = Record<string, string | undefined>;

/** The base URL of a request sent over a socket: the socket is the address, the host fills in. */
export const SOCKET_URL = "http://localhost";

/** A server's socket, and whether the environment named it rather than the CLI finding it. */
export interface FoundServer {
  socket: string;
  /** `LOXEL_SOCKET`'s: the Loxel of the terminal the CLI runs in, which it does not focus. */
  given: boolean;
}

const PROBE_TIMEOUT_MS = 1000;
const WAIT_INTERVAL_MS = 200;
/**
 * How long a given socket may have no server at all before the CLI launches Loxel for it: long
 * enough, once the old server is gone, for Restart Loxel or an update install to bring the next one
 * up by itself.
 */
const GIVEN_GRACE_MS = 10_000;
/** How long a server may stay draining before the CLI stops waiting for its replacement. */
const HANDOVER_MAX_MS = 60_000;

/**
 * The sockets a server for this user may be on, in the order to try: `LOXEL_STATE_DIR`'s, else
 * production's, then dev's.
 */
export function wellKnownSockets(env: Env): string[] {
  if (env.LOXEL_STATE_DIR) return [cliSocketPath(env.LOXEL_STATE_DIR)];
  return [cliSocketPath(DEFAULT_STATE_DIR.production), cliSocketPath(DEFAULT_STATE_DIR.dev)];
}

/** Why the socket at `path` cannot be opened from here, or null when nothing listens there. */
function blockedReason(err: unknown, path: string): string | null {
  const code = err instanceof Error && "code" in err ? err.code : undefined;
  // The socket and its directory are the user's own, with no access for anyone else.
  if (code === "EACCES") return `the Loxel server at ${path} runs as another user`;
  // A sandbox's own rules deny it, which no file mode does.
  if (code === "EPERM") return outsideSandbox(path);
  return null;
}

function outsideSandbox(path: string): string {
  return `Loxel's socket ${path} is outside this sandbox: allow it in the sandbox's settings`;
}

/**
 * Why the CLI must not connect to the socket at `path`, or null when it may: the socket's
 * directory exists but is not a directory of this user's that no one else can enter (0700).
 * Whoever owns that directory decides what listens in it, which matters for the temporary
 * directory a deep state directory's socket falls back to, whose name anyone can predict. A
 * missing directory is fine: nothing listens there, and the connection fails.
 */
function untrustedDirReason(path: string): string | null {
  const dir = dirname(path);
  let stat;
  try {
    stat = lstatSync(dir, { throwIfNoEntry: false });
  } catch (err) {
    return blockedReason(err, path);
  }
  if (!stat) return null;
  const isPrivate =
    stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700;
  return isPrivate
    ? null
    : `${dir} is not a private directory of this user's, so the loxel CLI does not use the socket in it`;
}

type Probe =
  | { state: "up" }
  | { state: "draining" }
  | { state: "down" }
  | { state: "blocked"; reason: string };

/**
 * Whether a Loxel server answers on the socket at `path`, or one that is shutting down (`draining`),
 * whose replacement is the one to talk to. A missing or stale socket file (a refused connection)
 * means none does. A socket in a directory that is not private to this user is never connected to.
 */
async function probe(path: string): Promise<Probe> {
  const untrusted = untrustedDirReason(path);
  if (untrusted) return { state: "blocked", reason: untrusted };
  try {
    const res = await fetch(`${SOCKET_URL}/api/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      unix: path,
    });
    if (!res.ok) return { state: "down" };
    const body: unknown = await res.json().catch(() => null);
    const shuttingDown =
      typeof body === "object" && body !== null && "shuttingDown" in body && body.shuttingDown;
    return shuttingDown === true ? { state: "draining" } : { state: "up" };
  } catch (err) {
    const reason = blockedReason(err, path);
    return reason ? { state: "blocked", reason } : { state: "down" };
  }
}

/**
 * The first well-known socket a server answers on, or null. Throws when a socket cannot be opened
 * from here, saying why, since launching Loxel would not help.
 */
async function locate(env: Env): Promise<string | null> {
  let blocked: string | null = null;
  for (const path of wellKnownSockets(env)) {
    const result = await probe(path);
    if (result.state === "up") return path;
    if (result.state === "blocked") blocked ??= result.reason;
  }
  if (blocked) throw new Error(blocked);
  return null;
}

/** `LOXEL_SOCKET`'s server, as given: it may be restarting, and opens retry until it is back. */
async function givenSocket(path: string): Promise<FoundServer> {
  try {
    statSync(dirname(path));
  } catch (err) {
    // The server makes the socket's directory before any terminal starts: one this process cannot
    // see is another user's, outside its sandbox or container, or gone.
    const reason =
      blockedReason(err, path) ??
      `cannot find Loxel's socket ${path}: if this runs in a sandbox, allow the path in its settings`;
    throw new Error(reason, { cause: err });
  }
  const result = await probe(path);
  if (result.state === "blocked") throw new Error(result.reason);
  return { socket: path, given: true };
}

/**
 * The server to talk to: `LOXEL_SOCKET`'s, else the first found on a well-known socket (see
 * {@link wellKnownSockets}). Null when no server is up. Throws when a socket cannot be opened from
 * here, saying why.
 */
export async function findServer(env: Env): Promise<FoundServer | null> {
  if (env.LOXEL_SOCKET) return givenSocket(env.LOXEL_SOCKET);
  const socket = await locate(env);
  return socket ? { socket, given: false } : null;
}

interface GoneOptions {
  /** Called once when no server answers right away and the wait starts. */
  onWaiting?: () => void;
  graceMs?: number;
  maxWaitMs?: number;
  /** The socket launching Loxel brings a server to; tests pass their own. */
  productionSocket?: string;
}

/**
 * Whether the CLI should launch Loxel for the socket `LOXEL_SOCKET` names: the production one, when
 * no server answers on it for the grace period. That is a terminal that outlived its Loxel after a
 * quit, where nothing else would bring the server back. A dev or demo server is not started by
 * launching the app. A draining server means a quit, restart or update is under way, so the grace
 * period starts only once it is gone; launching would race an update's own relaunch. One draining
 * for longer than `maxWaitMs` gets no launch either: launching would not help it.
 */
export async function givenServerGone(
  socket: string,
  {
    onWaiting,
    graceMs = GIVEN_GRACE_MS,
    maxWaitMs = HANDOVER_MAX_MS,
    productionSocket = cliSocketPath(DEFAULT_STATE_DIR.production),
  }: GoneOptions = {},
): Promise<boolean> {
  if (socket !== productionSocket) return false;
  const start = Date.now();
  let goneSince = start;
  let waiting = false;
  for (;;) {
    const { state } = await probe(socket);
    if (state === "up") return false;
    const now = Date.now();
    if (state === "draining") goneSince = now;
    else if (now - goneSince >= graceMs) return true;
    if (now - start >= maxWaitMs) return false;
    if (!waiting) onWaiting?.();
    waiting = true;
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
}

/**
 * Wait for a server Loxel is launching to answer on a well-known socket; `onWaiting` is called
 * once, when the wait starts.
 */
export async function waitForServer(
  env: Env,
  { timeoutMs = 15_000, onWaiting }: { timeoutMs?: number; onWaiting?: () => void } = {},
): Promise<string> {
  onWaiting?.();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const socket = await locate(env);
    if (socket) return socket;
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`Loxel server did not start within ${timeoutMs / 1000}s`);
}
