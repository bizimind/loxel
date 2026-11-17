/**
 * How the `loxel` CLI finds the Loxel server: on the server's Unix socket, which only the user's
 * own account can open (see src/server/cli-socket.ts). The CLI never uses the server's TCP port.
 * See docs/TERMINALS.md#the-loxel-cli.
 */
import { statSync } from "node:fs";
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
 * How long a given socket may have no server before the CLI launches Loxel for it: long enough for
 * Restart Loxel or an update install to bring the server back by itself.
 */
const GIVEN_GRACE_MS = 10_000;

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

type Probe = { state: "up" } | { state: "down" } | { state: "blocked"; reason: string };

/**
 * Whether a Loxel server answers on the socket at `path`. A missing or stale socket file (a refused
 * connection) means none does, and so does one shutting down: its replacement is the one to talk
 * to.
 */
async function probe(path: string): Promise<Probe> {
  try {
    const res = await fetch(`${SOCKET_URL}/api/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      unix: path,
    });
    if (!res.ok) return { state: "down" };
    const body: unknown = await res.json().catch(() => null);
    const shuttingDown =
      typeof body === "object" && body !== null && "shuttingDown" in body && body.shuttingDown;
    return shuttingDown === true ? { state: "down" } : { state: "up" };
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
  /** The socket launching Loxel brings a server to; tests pass their own. */
  productionSocket?: string;
}

/**
 * Whether the CLI should launch Loxel for the socket `LOXEL_SOCKET` names: the production one, when
 * no server answers on it within the grace period. That is a terminal that outlived its Loxel
 * after a quit, where nothing else would bring the server back. A dev or demo server is not started
 * by launching the app.
 */
export async function givenServerGone(
  socket: string,
  {
    onWaiting,
    graceMs = GIVEN_GRACE_MS,
    productionSocket = cliSocketPath(DEFAULT_STATE_DIR.production),
  }: GoneOptions = {},
): Promise<boolean> {
  if (socket !== productionSocket) return false;
  const start = Date.now();
  let waiting = false;
  while ((await probe(socket)).state !== "up") {
    if (Date.now() - start >= graceMs) return true;
    if (!waiting) onWaiting?.();
    waiting = true;
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  return false;
}

/** Wait for a server Loxel is launching to answer on a well-known socket. */
export async function waitForServer(env: Env, { timeoutMs = 15_000 } = {}): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const socket = await locate(env);
    if (socket) return socket;
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`Loxel server did not start within ${timeoutMs / 1000}s`);
}
